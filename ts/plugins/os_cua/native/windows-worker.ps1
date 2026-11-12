# Windows worker for OS Computer Use. One request on stdin (JSON), one reply on stdout (JSON), then exit.
# Commands: windows | screenshot | snapshot | input. It never runs anything from the request: the request only
# names a window and one bounded action. Windows PowerShell 5.1 compatible; the C# below targets C# 5.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public class CuaError : Exception {
  public string Code;
  public CuaError(string code, string message) : base(message) { Code = "os_cua_" + code; }
}

public static class Cua {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

  const int MaxWindows = 64, MaxNodes = 100, MaxDepth = 12, MaxPngBase64 = 1500000;

  // Physical pixels everywhere, so window bounds, screenshots and input points agree on scaled displays.
  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
    SetProcessDPIAware();
  }

  static long ExStyle(IntPtr hwnd) { return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20); }

  static bool Bounds(IntPtr hwnd, out RECT rect) {
    // The frame bounds exclude the invisible resize border that GetWindowRect includes.
    if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0 && rect.Right > rect.Left && rect.Bottom > rect.Top) return true;
    return GetWindowRect(hwnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top;
  }

  static Hashtable Describe(IntPtr hwnd, IntPtr foreground) {
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return null;
    int cloaked;
    if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return null;
    if ((ExStyle(hwnd) & 0x80) != 0) return null;
    int length = GetWindowTextLength(hwnd);
    if (length <= 0) return null;
    RECT rect;
    if (!Bounds(hwnd, out rect)) return null;
    StringBuilder title = new StringBuilder(length + 1);
    GetWindowText(hwnd, title, title.Capacity);
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    string app = "";
    try { app = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
    Hashtable bounds = new Hashtable();
    bounds["x"] = rect.Left; bounds["y"] = rect.Top; bounds["w"] = rect.Right - rect.Left; bounds["h"] = rect.Bottom - rect.Top;
    Hashtable row = new Hashtable();
    row["id"] = hwnd.ToInt64().ToString(); row["title"] = title.ToString(); row["app"] = app; row["bounds"] = bounds; row["focused"] = hwnd == foreground;
    return row;
  }

  public static object[] Windows() {
    List<object> rows = new List<object>();
    IntPtr foreground = GetForegroundWindow();
    EnumWindows(delegate(IntPtr hwnd, IntPtr lParam) {
      Hashtable row = Describe(hwnd, foreground);
      if (row != null && rows.Count < MaxWindows) rows.Add(row);
      return true;
    }, IntPtr.Zero);
    if (rows.Count == 0 && GetSystemMetrics(0) <= 0) throw new CuaError("no_desktop", "There is no interactive Windows desktop. Unlock the local desktop and retry.");
    return rows.ToArray();
  }

  static IntPtr Resolve(string id, out Hashtable window) {
    long value;
    if (String.IsNullOrEmpty(id) || !Int64.TryParse(id, out value)) throw new CuaError("invalid_request", "A windowId from os_windows is required.");
    IntPtr hwnd = new IntPtr(value);
    window = IsWindow(hwnd) ? Describe(hwnd, GetForegroundWindow()) : null;
    if (window == null) throw new CuaError("window_changed", "The window has closed, been minimised or hidden. Run os_windows again.");
    return hwnd;
  }

  static string Encode(Bitmap bitmap, out int width, out int height) {
    Bitmap current = bitmap;
    try {
      for (int attempt = 0; attempt < 10; attempt++) {
        using (MemoryStream stream = new MemoryStream()) {
          current.Save(stream, ImageFormat.Png);
          string encoded = Convert.ToBase64String(stream.ToArray());
          if (encoded.Length <= MaxPngBase64) { width = current.Width; height = current.Height; return encoded; }
        }
        // Too large for one tool result: shrink and try again. The caller gets the original bounds to convert points.
        int w = Math.Max(1, (int)(current.Width * 0.8)), h = Math.Max(1, (int)(current.Height * 0.8));
        Bitmap smaller = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(smaller)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(current, 0, 0, w, h); }
        if (current != bitmap) current.Dispose();
        current = smaller;
      }
    } finally { if (current != bitmap) current.Dispose(); }
    throw new CuaError("result_limit", "The screenshot exceeded its byte limit. Try capturing a smaller window.");
  }

  public static Hashtable Screenshot(string windowId) {
    RECT area; Bitmap bitmap = null;
    if (String.IsNullOrEmpty(windowId)) {
      int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
      if (w <= 0 || h <= 0) throw new CuaError("no_desktop", "The primary display is unavailable. Unlock the local desktop and retry.");
      area = new RECT(); area.Left = 0; area.Top = 0; area.Right = w; area.Bottom = h;
      bitmap = new Bitmap(w, h);
      using (Graphics g = Graphics.FromImage(bitmap)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
    } else {
      Hashtable window; IntPtr hwnd = Resolve(windowId, out window);
      RECT full; GetWindowRect(hwnd, out full);
      Bounds(hwnd, out area);
      int fw = full.Right - full.Left, fh = full.Bottom - full.Top;
      Bitmap whole = new Bitmap(fw, fh);
      bool drawn;
      using (Graphics g = Graphics.FromImage(whole)) {
        IntPtr hdc = g.GetHdc();
        // PW_RENDERFULLCONTENT: the window draws itself, so a window covered by others is still captured.
        try { drawn = PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
      }
      if (!drawn) {
        using (Graphics g = Graphics.FromImage(whole)) g.CopyFromScreen(full.Left, full.Top, 0, 0, new Size(fw, fh));
      }
      // Crop the invisible resize border so image points line up with the reported bounds.
      Rectangle crop = new Rectangle(area.Left - full.Left, area.Top - full.Top, area.Right - area.Left, area.Bottom - area.Top);
      crop.Intersect(new Rectangle(0, 0, fw, fh));
      bitmap = whole.Clone(crop, whole.PixelFormat);
      whole.Dispose();
    }
    try {
      int width, height;
      Hashtable bounds = new Hashtable();
      bounds["x"] = area.Left; bounds["y"] = area.Top; bounds["w"] = area.Right - area.Left; bounds["h"] = area.Bottom - area.Top;
      Hashtable result = new Hashtable();
      result["pngBase64"] = Encode(bitmap, out width, out height); result["width"] = width; result["height"] = height; result["bounds"] = bounds;
      return result;
    } finally { bitmap.Dispose(); }
  }

  public static Hashtable Snapshot(string windowId) {
    Hashtable window; IntPtr hwnd = Resolve(windowId, out window);
    Hashtable bounds = (Hashtable)window["bounds"];
    int originX = (int)bounds["x"], originY = (int)bounds["y"], width = (int)bounds["w"], height = (int)bounds["h"];
    AutomationElement root;
    try { root = AutomationElement.FromHandle(hwnd); }
    catch (Exception) { throw new CuaError("window_unresolved", "UI Automation could not read this window. Try another visible window."); }
    List<object> nodes = new List<object>();
    bool truncated = false;
    Stack<KeyValuePair<AutomationElement, int>> pending = new Stack<KeyValuePair<AutomationElement, int>>();
    pending.Push(new KeyValuePair<AutomationElement, int>(root, 0));
    TreeWalker walker = TreeWalker.ControlViewWalker;
    while (pending.Count > 0) {
      KeyValuePair<AutomationElement, int> entry = pending.Pop();
      AutomationElement element = entry.Key; int depth = entry.Value;
      if (nodes.Count >= MaxNodes) { truncated = true; break; }
      try {
        AutomationElement.AutomationElementInformation info = element.Current;
        Hashtable node = new Hashtable();
        node["depth"] = depth;
        node["role"] = info.ControlType.ProgrammaticName.Replace("ControlType.", "");
        // Names only: never the value of an editable or password field.
        if (!info.IsPassword && !String.IsNullOrEmpty(info.Name)) node["label"] = info.Name.Length > 120 ? info.Name.Substring(0, 120) : info.Name;
        node["enabled"] = info.IsEnabled;
        System.Windows.Rect box = info.BoundingRectangle;
        if (!box.IsEmpty && !info.IsOffscreen) {
          int px = (int)(box.X + box.Width / 2) - originX, py = (int)(box.Y + box.Height / 2) - originY;
          if (px >= 0 && py >= 0 && px < width && py < height) { Hashtable point = new Hashtable(); point["x"] = px; point["y"] = py; node["point"] = point; }
        }
        nodes.Add(node);
        if (depth >= MaxDepth) continue;
        List<AutomationElement> children = new List<AutomationElement>();
        for (AutomationElement child = walker.GetFirstChild(element); child != null && children.Count < MaxNodes; child = walker.GetNextSibling(child)) children.Add(child);
        for (int i = children.Count - 1; i >= 0; i--) pending.Push(new KeyValuePair<AutomationElement, int>(children[i], depth + 1));
      } catch (ElementNotAvailableException) { }
    }
    Hashtable result = new Hashtable();
    result["window"] = window; result["nodes"] = nodes.ToArray(); result["truncated"] = truncated;
    return result;
  }

  static INPUT Mouse(uint flags, int data) { INPUT input = new INPUT(); input.type = 0; input.u.mi.dwFlags = flags; input.u.mi.mouseData = unchecked((uint)data); return input; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT input = new INPUT(); input.type = 1; input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags; return input; }
  static void Send(List<INPUT> inputs) {
    INPUT[] batch = inputs.ToArray();
    if (SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(INPUT))) != batch.Length)
      throw new CuaError("input_blocked", "Windows blocked synthetic input. A window running as administrator, or a secure desktop, cannot be driven.");
  }

  static void Focus(IntPtr hwnd) {
    if (GetForegroundWindow() != hwnd) {
      // An ALT tap lifts the foreground lock so SetForegroundWindow is honoured for a background process.
      List<INPUT> alt = new List<INPUT>(); alt.Add(Key(0x12, 0, 0)); alt.Add(Key(0x12, 0, 2)); Send(alt);
      SetForegroundWindow(hwnd);
      for (int i = 0; i < 20 && GetForegroundWindow() != hwnd; i++) Thread.Sleep(15);
    }
    if (GetForegroundWindow() != hwnd) throw new CuaError("window_not_focused", "The target window could not be focused. Check for a modal dialog or choose another visible window.");
  }

  static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort> {
    { "enter", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "up", 0x26 }, { "down", 0x28 },
    { "left", 0x25 }, { "right", 0x27 }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 }, { "space", 0x20 } };
  static readonly Dictionary<string, ushort> Modifiers = new Dictionary<string, ushort> { { "ctrl", 0x11 }, { "alt", 0x12 }, { "shift", 0x10 }, { "cmd", 0x5B } };

  public static void Input(string type, string windowId, int x, int y, string button, int deltaY, string key, string[] modifiers, string text) {
    Hashtable window; IntPtr hwnd = Resolve(windowId, out window);
    Hashtable bounds = (Hashtable)window["bounds"];
    Focus(hwnd);
    List<INPUT> inputs = new List<INPUT>();
    if (type == "click" || type == "double_click" || type == "scroll") {
      if (x < 0 || y < 0 || x >= (int)bounds["w"] || y >= (int)bounds["h"]) throw new CuaError("point_outside_window", "The pointer coordinates are outside the target window.");
      POINT point = new POINT(); point.X = (int)bounds["x"] + x; point.Y = (int)bounds["y"] + y;
      IntPtr under = GetAncestor(WindowFromPoint(point), 2);
      if (under != hwnd) throw new CuaError("point_covered", "The point is covered or belongs to another window. Inspect the target again.");
      if (!SetCursorPos(point.X, point.Y)) throw new CuaError("point_offscreen", "That point is outside the active displays.");
      Thread.Sleep(30);
      if (type == "scroll") {
        // Positive deltaY scrolls down; one wheel notch (120) is about 100 points.
        inputs.Add(Mouse(0x0800, (int)Math.Round(-deltaY * 1.2)));
      } else {
        uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u, up = down << 1;
        int presses = type == "double_click" ? 2 : 1;
        for (int i = 0; i < presses; i++) { inputs.Add(Mouse(down, 0)); inputs.Add(Mouse(up, 0)); }
      }
    } else if (type == "key") {
      ushort vk; bool shift = false;
      if (!Named.TryGetValue(key ?? "", out vk)) {
        if (key == null || key.Length != 1) throw new CuaError("invalid_request", "Use a named or single key for key input. Use text for Unicode characters.");
        short scan = VkKeyScan(key[0]);
        if (scan == -1) throw new CuaError("invalid_request", "That key is not on the current keyboard layout. Use text for Unicode characters.");
        vk = (ushort)(scan & 0xFF); shift = (scan & 0x100) != 0;
      }
      List<ushort> held = new List<ushort>();
      if (modifiers != null) foreach (string name in modifiers) { ushort code; if (Modifiers.TryGetValue(name, out code) && !held.Contains(code)) held.Add(code); }
      if (shift && !held.Contains(0x10)) held.Add(0x10);
      foreach (ushort code in held) inputs.Add(Key(code, 0, 0));
      inputs.Add(Key(vk, 0, 0)); inputs.Add(Key(vk, 0, 2));
      for (int i = held.Count - 1; i >= 0; i--) inputs.Add(Key(held[i], 0, 2));
    } else if (type == "text") {
      // KEYEVENTF_UNICODE delivers each UTF-16 unit without depending on the keyboard layout.
      foreach (char unit in text ?? "") { inputs.Add(Key(0, unit, 4)); inputs.Add(Key(0, unit, 4 | 2)); }
    } else throw new CuaError("invalid_request", "Invalid Windows input action.");
    if (GetForegroundWindow() != hwnd) throw new CuaError("window_not_focused", "The target window lost focus before input. Observe the desktop again.");
    Send(inputs);
  }
}
'@

function Reply($value) { [Console]::Out.Write(($value | ConvertTo-Json -Depth 8 -Compress)) }

try {
  $raw = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)
  if ($raw.Length -gt 65536) { throw (New-Object System.InvalidOperationException 'request too large') }
  $request = $raw | ConvertFrom-Json
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase
  [Cua]::Init()
  switch ($request.command) {
    'windows' { $value = @([Cua]::Windows()) }
    'screenshot' { $value = [Cua]::Screenshot([string]$request.windowId) }
    'snapshot' { $value = [Cua]::Snapshot([string]$request.windowId) }
    'input' {
      $action = $request.action
      if ($null -eq $action) { throw (New-Object CuaError 'invalid_request', 'An input action is required.') }
      $modifiers = @(); if ($null -ne $action.modifiers) { $modifiers = @($action.modifiers | ForEach-Object { [string]$_ }) }
      $x = 0; $y = 0; $delta = 0
      if ($null -ne $action.x) { $x = [int]$action.x }; if ($null -ne $action.y) { $y = [int]$action.y }; if ($null -ne $action.deltaY) { $delta = [int]$action.deltaY }
      [Cua]::Input([string]$action.type, [string]$action.windowId, $x, $y, [string]$action.button, $delta, [string]$action.key, [string[]]$modifiers, [string]$action.text)
      $value = @{ applied = $true }
    }
    default { throw (New-Object CuaError 'invalid_request', 'Unknown Windows computer-use command.') }
  }
  if ($request.command -eq 'windows') { [Console]::Out.Write((ConvertTo-Json -InputObject @{ ok = $true; value = $value } -Depth 8 -Compress)) }
  else { Reply @{ ok = $true; value = $value } }
} catch {
  $inner = $_.Exception
  while ($null -ne $inner -and -not ($inner.GetType().Name -eq 'CuaError') -and $null -ne $inner.InnerException) { $inner = $inner.InnerException }
  if ($null -ne $inner -and $inner.GetType().Name -eq 'CuaError') { Reply @{ ok = $false; code = $inner.Code; message = $inner.Message } }
  elseif ($env:XUENESS_OS_CUA_DEBUG -eq '1') { Reply @{ ok = $false; code = 'os_cua_execution_failed'; message = [string]$_.Exception } }
  else { Reply @{ ok = $false; code = 'os_cua_execution_failed'; message = 'Windows did not complete the requested desktop action.' } }
}
