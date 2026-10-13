package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const loginLabel = "Start on login"

func autostartFile(name string) string {
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "autostart", name)
}

var (
	linuxAutostart    = autostartFile("nextstickies.desktop")
	oldLinuxAutostart = autostartFile("nc-sticky-notes.desktop")
)

// launchPath is the AppImage path when running from one (the executable itself lives in a temporary mount).
func launchPath() string {
	if p := os.Getenv("APPIMAGE"); p != "" {
		return p
	}
	exe, _ := os.Executable()
	return exe
}

func startWithLogin() bool {
	_, err := os.Stat(linuxAutostart)
	return err == nil
}

func setStartWithLogin(enabled bool) error {
	if !enabled {
		if err := os.Remove(linuxAutostart); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(linuxAutostart), 0o755); err != nil {
		return err
	}
	entry := "[Desktop Entry]\nType=Application\nName=NextStickies\nExec=\"" + launchPath() +
		"\"\nIcon=nextstickies\nX-GNOME-Autostart-enabled=true\n"
	return os.WriteFile(linuxAutostart, []byte(entry), 0o644)
}

// migrateStartWithLogin points an existing autostart entry at this executable: entries from the pre-rename app or
// the Electron AppImage would otherwise start the old version (two apps syncing one folder).
func migrateStartWithLogin() {
	if _, err := os.Stat(oldLinuxAutostart); err == nil {
		os.Remove(oldLinuxAutostart)
		_ = setStartWithLogin(true)
		return
	}
	if data, err := os.ReadFile(linuxAutostart); err == nil && !strings.Contains(string(data), "Exec=\""+launchPath()+"\"\n") {
		_ = setStartWithLogin(true)
	}
}
