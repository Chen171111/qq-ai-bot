// ocr.cs — 用 Windows 自带的 Windows.Media.Ocr 做本地 OCR（零安装、零依赖）。
//
// 为什么是 C# 而不是 PowerShell（2026-10-19 连踩十轮坑后的结论）：
//   PS 5.1 调 WinRT 处处别扭：脚本要 UTF-8 BOM、类型字面量必须静态加载、
//   Language 的程序集名是 Windows.Globalization、AsTask 泛型重载解析失败、
//   文件 API 在本机返回原始 COM 对象（加 -STA 也无效）。
//   C# 对 WinRT 是原生支持，一次编译长期复用。
//
// 为什么不用 .AsTask()（2026-10-19 实测）：
//   本机没装 Windows SDK，缺合并的 Windows.winmd，导致
//   System.Runtime.WindowsRuntime 的 AsTask 扩展方法无法解析
//   （CS0012 缺 Windows 元程序集 + CS1929 无法转换）。
//   所以这里直接用 WinRT 接口自带的 .GetResults()——IAsyncOperation
//   本身就有同步取结果的方法，不需要任何扩展。
//
// 为什么输出写文件而不是 stdout：
//   2026-10-18 实测：本机 node 的「管道捕获输出」式 spawn 间歇 EBUSY
//   （execFileSync/管道约五成失败，stdio:'ignore' 10/10 正常）。
//   本程序一律写入参指定的输出文件，调用方用 stdio:'ignore' 起进程再读文件。
//
// 用法：ocr.exe <图片路径> <输出文件路径>
//   成功：exit 0，输出文件写识别文本（可能为空串 = 图里没文字）
//   失败：exit 1，输出文件写 "##ERR##<原因>"
//
// 编译：node build-ocr.mjs（参数与踩坑都写在那个脚本里）

using System;
using System.IO;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

static class OcrTool
{
    static string _img;
    static string _out;
    static int _rc = 1;

    /// <summary>
    /// 同步等待 WinRT 异步操作完成。
    ///
    /// 为什么不能直接 .GetResults()：2026-10-19 实测直接调会抛
    /// 「在意外的时间调用了方法」（RPC_E_WRONG_THREAD 族）——异步还没完成
    /// 就去取结果。也不能用 .AsTask()：本机没装 Windows SDK，缺合并的
    /// Windows.winmd，System.Runtime.WindowsRuntime 的 AsTask 扩展无法解析
    /// （CS0012 + CS1929）。所以这里轮询 Status + 短睡眠等待，最稳。
    /// </summary>
    static T Await<T>(IAsyncOperation<T> op, int timeoutMs = 30000)
    {
        int waited = 0;
        while (op.Status == AsyncStatus.Started)
        {
            if (waited >= timeoutMs) throw new TimeoutException("WinRT 异步操作超时 " + timeoutMs + "ms");
            Thread.Sleep(15);
            waited += 15;
        }
        if (op.Status == AsyncStatus.Error)
            throw op.ErrorCode;
        return op.GetResults();
    }

    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("用法: ocr.exe <图片路径> <输出文件路径>");
            return 1;
        }
        _img = args[0];
        _out = args[1];

        // WinRT 的文件 IO 在 STA 公寓下才稳（MTA 下实测返回原始 COM 对象、投影失效）。
        var th = new Thread(Work);
        th.SetApartmentState(ApartmentState.STA);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        th.Start();
        bool finished = th.Join(60000); // 60s 硬顶，防卡死
        sw.Stop();
        // 注意：Work 内部失败时已经自己写过一次输出文件（含真实原因），
        // 这里只在「线程没跑完」时补写，否则会把真实错误覆盖掉。
        if (!finished) Fail("OCR 超时（线程 60s 未结束）");
        return _rc;
    }

    static void Work()
    {
        try
        {
            // 2026-10-19 实测两条死路（都试过）：
            //   1. StorageFile.GetFileFromPathAsync → 「UNABLE_TO_MASK_PATH」，
            //      非打包桌面应用的 WinRT 文件代理限制；
            //   2. MemoryStream.AsRandomAccessStream → 「该项目没有位于应用程序
            //      可以访问的位置」，同一族限制（适配器仍走文件许可）。
            // 活路：用纯 WinRT 的 InMemoryRandomAccessStream 写入字节，
            // 完全不碰文件系统许可——这才能让 BitmapDecoder 读到图。
            byte[] bytes = File.ReadAllBytes(_img);
            var ras = new InMemoryRandomAccessStream();
            var writer = new Windows.Storage.Streams.DataWriter(ras.GetOutputStreamAt(0));
            writer.WriteBytes(bytes);
            Await(writer.StoreAsync());
            Await(writer.FlushAsync());
            writer.DetachStream();
            ras.Seek(0);
            BitmapDecoder decoder = Await(BitmapDecoder.CreateAsync(ras));
            SoftwareBitmap bitmap = Await(decoder.GetSoftwareBitmapAsync());

            OcrEngine engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("zh-Hans-CN"));
            if (engine == null)
            {
                Fail("系统没有中文 OCR 语言包（zh-Hans-CN）");
                return;
            }

            OcrResult result = Await(engine.RecognizeAsync(bitmap));
            File.WriteAllText(_out, result.Text ?? "", new UTF8Encoding(false));
            _rc = 0;
        }
        catch (Exception e)
        {
            // 把完整堆栈写出去，便于定位是哪一步炸的（生产环境也保留，出问题好查）
            Fail(e.InnerException != null
                ? "内层: " + e.InnerException.Message + " || 外层: " + e.Message
                : e.Message + " || 堆栈: " + (e.StackTrace ?? "").Replace("\n", " "));
        }
    }

    static void Fail(string msg)
    {
        // 同时打 stderr：写得进文件时以文件为准，写不进（如路径异常）也不至于全哑
        try { Console.Error.WriteLine("##ERR##" + msg); } catch { }
        try
        {
            File.WriteAllText(_out, "##ERR##" + msg.Replace("\r", " ").Replace("\n", " "), new UTF8Encoding(false));
        }
        catch { }
        _rc = 1;
    }
}
