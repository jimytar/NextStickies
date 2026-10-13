package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// protect encrypts with CurrentUser DPAPI, the format the 1.x WPF app wrote to ProtectedPassword.
func protect(password string) (string, error) {
	out, err := dpapi([]byte(password), true)
	return base64.StdEncoding.EncodeToString(out), err
}

func unprotect(blob string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		return "", err
	}
	out, err := dpapi(data, false)
	return string(out), err
}

func dpapi(data []byte, encrypt bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty data")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	var err error
	if encrypt {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

// decryptElectron reads a password saved by the Electron app's safeStorage: AES-256-GCM ("v10" + 12-byte nonce +
// ciphertext) with a key that Chromium keeps DPAPI-protected in "<userData>/Local State".
func decryptElectron(dataDir, blob string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(blob)
	if err != nil || len(data) < 3+12+16 || string(data[:3]) != "v10" {
		return "", errors.New("unsupported safeStorage blob")
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "electron", "Local State"))
	if err != nil {
		return "", err
	}
	var state struct {
		OSCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return "", err
	}
	wrapped, err := base64.StdEncoding.DecodeString(state.OSCrypt.EncryptedKey)
	if err != nil || len(wrapped) < 5 || string(wrapped[:5]) != "DPAPI" {
		return "", errors.New("unsupported Local State key")
	}
	key, err := dpapi(wrapped[5:], false)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, data[3:15], data[15:], nil)
	return string(plain), err
}
