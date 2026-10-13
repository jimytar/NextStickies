package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Settings holds the Nextcloud connection and app preferences, in the settings.json shared with earlier versions.
// The password is encrypted for this user on this machine (see secret_*.go).
type Settings struct {
	ServerUrl string
	User      string
	Folder    string
	// Electron 1.x/2.x safeStorage blob; migrated to ProtectedPassword on first start where possible.
	EncryptedPassword string `json:",omitempty"`
	// Windows: CurrentUser DPAPI blob (same format as the 1.x WPF app). Linux: AES-GCM, key in the Secret Service.
	ProtectedPassword string `json:",omitempty"`
	StartMinimized    bool
}

func loadSettings(file string) (Settings, error) {
	s := Settings{Folder: "Notes"}
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, err
	}
	if s.EncryptedPassword != "" && s.ProtectedPassword == "" {
		if password, err := decryptElectron(filepath.Dir(file), s.EncryptedPassword); err == nil {
			if err := s.setPassword(password); err == nil {
				_ = saveSettings(file, s)
			}
		} // else leave it; the user can re-enter the password in Settings
	}
	return s, nil
}

func saveSettings(file string, s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(file, data, 0o600)
}

func (s Settings) hasPassword() bool { return s.ProtectedPassword != "" || s.EncryptedPassword != "" }

func (s Settings) isConfigured() bool { return s.ServerUrl != "" && s.User != "" && s.hasPassword() }

// remoteKey identifies the remote folder; when it changes the sync state no longer applies.
func (s Settings) remoteKey() string {
	return strings.TrimRight(s.ServerUrl, "/") + "|" + s.User + "|" + strings.Trim(s.Folder, "/")
}

func (s Settings) password() (string, error) {
	if s.ProtectedPassword != "" {
		return unprotect(s.ProtectedPassword)
	}
	return "", errors.New("no readable saved password")
}

func (s *Settings) setPassword(password string) error {
	s.EncryptedPassword, s.ProtectedPassword = "", ""
	if password == "" {
		return nil
	}
	blob, err := protect(password)
	s.ProtectedPassword = blob
	return err
}
