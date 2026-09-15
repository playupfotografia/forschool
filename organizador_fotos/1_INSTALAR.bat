@echo off
echo ============================================
echo   For School - Instalacao de dependencias
echo ============================================
echo.
echo Instalando pacotes necessarios...
echo (isso pode demorar alguns minutos na primeira vez)
echo.
pip install opencv-python Pillow requests
echo.
if %ERRORLEVEL% EQU 0 (
  echo ============================================
  echo   Instalacao concluida com sucesso!
  echo.
  echo   Sequencia de uso:
  echo   1. 2_ORGANIZAR.bat  - organiza fotos por aluno
  echo   2. 3_MONTAR_PRODUTOS.bat - separa por produto
  echo ============================================
) else (
  echo ============================================
  echo   ERRO na instalacao.
  echo   Verifique se o Python esta instalado:
  echo   https://www.python.org/downloads/
  echo   Marque "Add Python to PATH" na instalacao
  echo ============================================
)
echo.
pause
