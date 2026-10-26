# A Supabase és az e-mail küldés titkos adatainak beállítása felhasználói környezeti változóba (csak ezen a gépen).
# Indítás: dupla kattintás a scripts\titkok-beallitasa.cmd fájlra (NE a Claude Code-ban "!"-lel).
#
# Minden adatnál: másold ki a vágólapra, aztán az ablakban nyomj Entert – a szkript a vágólapról olvassa be.
# A titkot nem írja ki, csak az elejét és a hosszát. "k" + Enter = kihagyás (a meglévő érték marad).
# A végén a vágólapot törli.

$items = [ordered]@{
    SUPABASE_ACCESS_TOKEN    = @{ Text = 'Supabase hozzáférési token'; Check = '^sbp_\S{20,}$'; Hint = 'sbp_ kezdetű' }
    SUPABASE_SECRET_KEY_TEST = @{ Text = 'A TESZT projekt secret kulcsa'; Check = '^sb_secret_\S{10,}$'; Hint = 'sb_secret_ kezdetű' }
    SMTP_USER                = @{ Text = 'A küldő Gmail cím'; Check = '^[^@\s]+@[^@\s]+\.[^@\s]+$'; Hint = 'e-mail cím'; Plain = $true }
    SMTP_PASSWORD            = @{ Text = 'Gmail alkalmazásjelszó'; Check = '^[a-z]{16}$'; Hint = '16 kisbetű'; NoSpaces = $true }
    MATEK_ADMIN_EMAIL        = @{ Text = 'A te e-mail címed (ezzel leszel admin)'; Check = '^[^@\s]+@[^@\s]+\.[^@\s]+$'; Hint = 'e-mail cím'; Plain = $true }
}

function Show-Masked([string]$value, [bool]$plain) {
    if ($plain) { return $value }
    return "$($value.Substring(0, [Math]::Min(6, $value.Length)))… ($($value.Length) karakter)"
}

Write-Host ''
Write-Host 'Minden adatnál: MÁSOLD KI a vágólapra, majd itt nyomj ENTERT.' -ForegroundColor Cyan
Write-Host 'Kihagyás: írd be, hogy k, és Enter.' -ForegroundColor Cyan
Write-Host ''

foreach ($name in $items.Keys) {
    $item = $items[$name]
    $existing = [Environment]::GetEnvironmentVariable($name, 'User')
    while ($true) {
        $label = "$($item.Text)"
        if ($existing) { $label += ' [már be van állítva]' }
        $answer = Read-Host "$label – másold ki, aztán Enter (k = kihagyás)"
        if ($answer.Trim() -eq 'k') { Write-Host '  kihagyva' -ForegroundColor DarkGray; break }

        $value = if ($item.Plain -and $answer.Trim()) { $answer } else { Get-Clipboard -Raw }
        if ($null -eq $value) { $value = '' }
        $value = $value.Trim()
        if ($item.NoSpaces) { $value = $value -replace '\s', '' }

        if ($value -notmatch $item.Check) {
            Write-Host "  Ez nem tűnik jónak ($($item.Hint) kell). A vágólapon: $(Show-Masked $value $false). Próbáld újra!" -ForegroundColor Yellow
            continue
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'User')
        Write-Host "  beállítva: $(Show-Masked $value ([bool]$item.Plain))" -ForegroundColor Green
        break
    }
}

Set-Clipboard -Value ' '
Write-Host ''
Write-Host 'Kész, a vágólapot töröltem. Szólj Claude-nak, hogy folytathatja.' -ForegroundColor Cyan
