Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class InputSim {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);

    public const uint MOUSEEVENTF_MOVE = 0x0001;

    public static void Jiggle() {
        mouse_event(MOUSEEVENTF_MOVE, 1, 0, 0, 0);
        System.Threading.Thread.Sleep(100);
        mouse_event(MOUSEEVENTF_MOVE, -1, 0, 0, 0);
    }
}
'@

Write-Host "Keep-Awake started. Close this window to stop." -ForegroundColor Green

while ($true) {
    [InputSim]::Jiggle()
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] Input sent, next in 3 min...")
    Start-Sleep -Seconds 180
}
