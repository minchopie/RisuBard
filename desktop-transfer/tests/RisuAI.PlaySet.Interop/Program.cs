using RisuAI.ChatTransfer.Core;

Console.InputEncoding = System.Text.Encoding.UTF8;
Console.OutputEncoding = System.Text.Encoding.UTF8;
try
{
    if (args[0] == "transport") { await TransportInterop.Run(args[1]); return 0; }
    if (args[0] == "archive-create") { ArchiveInterop.Create(args[1]); return 0; }
    if (args[0] == "archive-verify") { ArchiveInterop.Verify(args[1], args[2]); return 0; }
    using var pairing = new PlaySetPairing("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", args[0].ToCharArray());
    string Read() => Console.ReadLine() ?? throw new EndOfStreamException();
    Console.WriteLine(pairing.Round1()); pairing.Accept1(Read());
    Console.WriteLine(pairing.Round2()); pairing.Accept2(Read());
    Console.WriteLine(pairing.Round3()); pairing.Accept3(Read());
    Console.WriteLine(pairing.Binding(new string('a', 64)));
    pairing.AcceptBinding(Read(), new string(args.Length > 1 ? 'c' : 'b', 64));
    Console.WriteLine("CONFIRMED");
    return 0;
}
catch (Exception e) { Console.Error.WriteLine(e.GetType().Name + ": " + e.Message); return 3; }
