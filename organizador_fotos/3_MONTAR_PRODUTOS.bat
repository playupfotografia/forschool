@echo off
echo ============================================
echo   For School - FASE 2: Montar Produtos
echo ============================================
echo.
echo Abrindo seletor de pasta...

:: Abre janela gráfica para escolher a pasta organizada
for /f "delims=" %%I in ('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Selecione a pasta ORGANIZADA (resultado do passo 2)'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }"') do set PASTA=%%I

if "%PASTA%"=="" (
  echo Nenhuma pasta selecionada. Encerrando.
  pause
  exit
)

echo.
echo Pasta selecionada: %PASTA%
echo.
python "%~dp0montar_produtos.py" "%PASTA%"
pause
