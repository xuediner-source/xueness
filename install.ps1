# Xueness Windows CLI bootstrap. Installer implementation belongs to desktop.
& {
    $uri = 'https://raw.githubusercontent.com/xuediner-source/xueness/main/desktop/src/cli-install.ps1'
    $body = Invoke-RestMethod -Uri $uri -ErrorAction Stop
    & ([ScriptBlock]::Create($body))
}
