// ============================================================
//  Liquid Glass Music — Windows SMTC bridge (.NET)
//  Reads Windows media sessions (Yandex Music desktop/web,
//  Spotify, browsers...) and exposes JSON lines on stdout.
//  Also receives playback commands as JSON files in CacheDir.
// ============================================================

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Windows.Media.Control;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static string _cacheDir = "";
    private static int _parentPid;

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);

        _cacheDir = GetArgument(args, "--cache-dir")
                    ?? Path.Combine(Path.GetTempPath(), "liquid-glass-music");

        var parentPid = GetArgument(args, "--parent-pid");
        _ = int.TryParse(parentPid, out _parentPid);

        Directory.CreateDirectory(_cacheDir);
        Cleanup();

        GlobalSystemMediaTransportControlsSessionManager? manager = null;
        var nextEmit = 0L;

        while (true)
        {
            if (_parentPid > 0 && !IsParentAlive())
                return;

            try
            {
                manager ??= GlobalSystemMediaTransportControlsSessionManager
                    .RequestAsync().AsTask().GetAwaiter().GetResult();

                var handledCommand = ProcessCommands(manager);
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                if (handledCommand || now >= nextEmit)
                {
                    var payload = BuildState(manager, now);
                    Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
                    Console.Out.Flush();
                    nextEmit = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1000;
                }
            }
            catch (Exception ex)
            {
                // A WinRT hiccup must not kill the widget: report and retry.
                manager = null;
                try
                {
                    var payload = new StatePayload
                    {
                        Type = "state",
                        At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        Ok = false,
                        Sessions = new List<SessionInfo>(),
                        Error = ex.Message
                    };
                    Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
                    Console.Out.Flush();
                }
                catch { }

                nextEmit = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 3000;
            }

            Thread.Sleep(400);
        }
    }

    private static StatePayload BuildState(
        GlobalSystemMediaTransportControlsSessionManager manager,
        long now)
    {
        var sessions = new List<SessionInfo>();

        foreach (var session in manager.GetSessions())
        {
            try
            {
                var props = session.TryGetMediaPropertiesAsync()
                    .AsTask().GetAwaiter().GetResult();

                var title = props.Title ?? "";
                var artist = props.Artist ?? "";
                var album = props.AlbumTitle ?? "";

                // Ignore empty system sessions (shell, updaters, etc.).
                if (string.IsNullOrWhiteSpace(title) &&
                    string.IsNullOrWhiteSpace(artist) &&
                    string.IsNullOrWhiteSpace(album))
                {
                    continue;
                }

                var playback = session.GetPlaybackInfo();
                var status = playback.PlaybackStatus.ToString().ToLowerInvariant();
                var timeline = session.GetTimelineProperties();

                var positionMs = timeline.Position.TotalMilliseconds;
                var durationMs = timeline.EndTime.TotalMilliseconds;

                if (status == "playing")
                {
                    var delta = (DateTimeOffset.UtcNow - timeline.LastUpdatedTime).TotalMilliseconds;
                    if (delta > 0) positionMs += delta;
                }

                if (durationMs < 0) durationMs = 0;
                if (positionMs < 0) positionMs = 0;
                if (durationMs > 0 && positionMs > durationMs) positionMs = durationMs;

                var canSeek = durationMs > 0 && timeline.MaxSeekTime.TotalMilliseconds > 0;

                GetCover(props, session.SourceAppUserModelId ?? "", title, artist, album,
                    out var coverPath, out var coverVersion);

                sessions.Add(new SessionInfo
                {
                    Aumid = session.SourceAppUserModelId ?? "",
                    Title = title,
                    Artist = artist,
                    Album = album,
                    Status = status,
                    PositionMs = (long)Math.Round(positionMs),
                    DurationMs = (long)Math.Round(durationMs),
                    CanSeek = canSeek,
                    CoverPath = coverPath,
                    CoverVersion = coverVersion
                });
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("session error: " + ex.Message);
            }
        }

        return new StatePayload
        {
            Type = "state",
            At = now,
            Ok = true,
            Sessions = sessions
        };
    }

    private static void GetCover(
        GlobalSystemMediaTransportControlsSessionMediaProperties props,
        string aumid,
        string title,
        string artist,
        string album,
        out string? coverPath,
        out string? coverVersion)
    {
        coverPath = null;
        coverVersion = null;

        if (props.Thumbnail is null) return;

        try
        {
            var key = $"{title}|{artist}|{album}";
            var appHash = ShortHash(aumid, 10);
            var keyHash = ShortHash(key, 16);
            var path = Path.Combine(_cacheDir, $"cover-{appHash}-{keyHash}.img");

            if (!File.Exists(path) || new FileInfo(path).Length == 0)
            {
                var stream = props.Thumbnail.OpenReadAsync()
                    .AsTask().GetAwaiter().GetResult();

                using (stream)
                using (var network = stream.AsStreamForRead())
                using (var memory = new MemoryStream())
                {
                    network.CopyTo(memory);
                    if (memory.Length > 0)
                    {
                        var temp = path + ".tmp";
                        File.WriteAllBytes(temp, memory.ToArray());
                        File.Move(temp, path, true);
                    }
                }
            }

            if (File.Exists(path) && new FileInfo(path).Length > 0)
            {
                coverPath = path;
                coverVersion = keyHash;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("cover error: " + ex.Message);
        }
    }

    private static bool ProcessCommands(
        GlobalSystemMediaTransportControlsSessionManager manager)
    {
        var handled = false;
        string[] files;

        try
        {
            files = Directory.GetFiles(_cacheDir, "command-*.json");
        }
        catch
        {
            return false;
        }

        Array.Sort(files, StringComparer.Ordinal);

        foreach (var file in files)
        {
            try
            {
                var json = File.ReadAllText(file, Encoding.UTF8);
                File.Delete(file);

                var command = JsonSerializer.Deserialize<MediaCommand>(json, JsonOptions);
                if (command is not null && !string.IsNullOrWhiteSpace(command.Action))
                {
                    ExecuteCommand(manager, command);
                    handled = true;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("command error: " + ex.Message);
                try { File.Delete(file); } catch { }
            }
        }

        return handled;
    }

    private static void ExecuteCommand(
        GlobalSystemMediaTransportControlsSessionManager manager,
        MediaCommand command)
    {
        GlobalSystemMediaTransportControlsSession? target = null;

        if (!string.IsNullOrWhiteSpace(command.Aumid))
        {
            target = manager.GetSessions().FirstOrDefault(s =>
                string.Equals(s.SourceAppUserModelId, command.Aumid, StringComparison.Ordinal));
        }

        target ??= manager.GetCurrentSession();
        if (target is null) return;

        switch (command.Action)
        {
            case "playpause":
                target.TryTogglePlayPauseAsync().AsTask().Wait(1500);
                break;

            case "play":
                if (target.GetPlaybackInfo().PlaybackStatus !=
                    GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                {
                    target.TryPlayAsync().AsTask().Wait(1500);
                }
                break;

            case "pause":
                if (target.GetPlaybackInfo().PlaybackStatus ==
                    GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                {
                    target.TryPauseAsync().AsTask().Wait(1500);
                }
                break;

            case "next":
                target.TrySkipNextAsync().AsTask().Wait(1500);
                break;

            case "prev":
                target.TrySkipPreviousAsync().AsTask().Wait(1500);
                break;

            case "seek":
                var ms = Math.Max(0, command.PositionMs);
                var ticks = (long)(ms * 10_000d);
                target.TryChangePlaybackPositionAsync(ticks).AsTask().Wait(1500);
                break;
        }
    }

    private static bool IsParentAlive()
    {
        // Electron passes its PID. If the widget dies, the bridge dies
        // with it instead of staying in Task Manager forever.
        try
        {
            using var parent = System.Diagnostics.Process.GetProcessById(_parentPid);
            return !parent.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static void Cleanup()
    {
        try
        {
            foreach (var file in Directory.GetFiles(_cacheDir, "command-*.json"))
            {
                try { File.Delete(file); } catch { }
            }

            foreach (var file in Directory.GetFiles(_cacheDir, "cover-*.img"))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddDays(-7))
                        File.Delete(file);
                }
                catch { }
            }
        }
        catch { }
    }

    private static string ShortHash(string text, int length)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(
            Encoding.UTF8.GetBytes(text));
        var value = Convert.ToHexString(hash).ToLowerInvariant();
        return value[..Math.Min(length, value.Length)];
    }

    private static string? GetArgument(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return null;
    }

    private sealed class StatePayload
    {
        public string Type { get; set; } = "state";
        public long At { get; set; }
        public bool Ok { get; set; }
        public List<SessionInfo> Sessions { get; set; } = new();
        public string? Error { get; set; }
    }

    private sealed class SessionInfo
    {
        public string Aumid { get; set; } = "";
        public string Title { get; set; } = "";
        public string Artist { get; set; } = "";
        public string Album { get; set; } = "";
        public string Status { get; set; } = "";
        public long PositionMs { get; set; }
        public long DurationMs { get; set; }
        public bool CanSeek { get; set; }
        public string? CoverPath { get; set; }
        public string? CoverVersion { get; set; }
    }

    private sealed class MediaCommand
    {
        public string Action { get; set; } = "";
        public string? Aumid { get; set; }
        public double PositionMs { get; set; }
    }
}
