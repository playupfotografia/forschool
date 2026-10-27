@echo off
rem Busca atualizacoes na internet (se houver) e abre o programa.
python -X utf8 "%~dp0atualizar.py"
start "" pythonw "%~dp0ForSchool_Fotos.py"
