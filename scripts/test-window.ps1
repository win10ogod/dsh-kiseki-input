param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
public class KisekiProbeForm : System.Windows.Forms.Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
'@
$form = [KisekiProbeForm]::new()
$form.Text = 'DSH Kiseki Plugin Test'
$form.Size = [Drawing.Size]::new(650,220)
$form.StartPosition = 'Manual'
$form.Location = [Drawing.Point]::new(30,30)
$label = [Windows.Forms.Label]::new()
$label.Text = 'Dedicated plugin verification window'
$label.Location = [Drawing.Point]::new(20,15)
$label.Size = [Drawing.Size]::new(550,25)
$box = [Windows.Forms.TextBox]::new()
$box.Multiline = $true
$box.Location = [Drawing.Point]::new(20,50)
$box.Size = [Drawing.Size]::new(590,100)
$box.Font = [Drawing.Font]::new('Segoe UI',13)
$form.Controls.Add($label)
$form.Controls.Add($box)
$box.Add_TextChanged({[IO.File]::WriteAllText((Join-Path $Directory 'observed.txt'),$box.Text,[Text.UTF8Encoding]::new($false))})
$form.Add_Shown({
  @{ pid=$PID; windowId=$form.Handle.ToInt64().ToString(); editId=$box.Handle.ToInt64().ToString() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'window.json') -Encoding utf8
})
$timer = [Windows.Forms.Timer]::new()
$timer.Interval=100
$timer.Add_Tick({
  # UIA can update the native edit control without raising the managed TextChanged event.
  [IO.File]::WriteAllText((Join-Path $Directory 'observed.txt'),$box.Text,[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath (Join-Path $Directory 'stop')) {$form.Close()}
})
$timer.Start()
try {[Windows.Forms.Application]::Run($form)} finally {$timer.Dispose();$form.Dispose()}
