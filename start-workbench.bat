@echo off
rem One-click door to the parametric floorplan workbench (procgen.html).
rem
rem Why this file exists:
rem   Opening procgen.html by double-clicking IT gives a blank shell -- browsers
rem   refuse ES modules over file://, so no line of the page runs.
rem   Plain start.bat opens the GAME: choosing a page needs the word "workbench"
rem   on the command line, and a double-click cannot supply one.
rem So this wrapper supplies it.
call "%~dp0start.bat" workbench
