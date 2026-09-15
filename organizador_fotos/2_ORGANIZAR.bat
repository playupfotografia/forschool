@echo off
echo ============================================
echo   For School - Organizador de Fotos
echo ============================================
echo.
echo Abrindo seletor de pasta...

:: Abre janela gráfica para escolher a pasta
for /f "delims=" %%I in ('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Selecione a pasta com as fotos do cartao de memoria'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }"') do set PASTA=%%I

if "%PASTA%"=="" (
  echo Nenhuma pasta selecionada. Encerrando.
  pause
  exit
)

echo.
echo Pasta selecionada: %PASTA%
echo.
python "%~dp0organizador_fotos.py" "%PASTA%"
pause
