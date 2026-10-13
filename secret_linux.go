package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"

	"github.com/zalando/go-keyring"
)

// The password is AES-GCM encrypted in settings.json; the key lives in the Secret Service (GNOME Keyring / KWallet),
// so settings stay readable and editable while the secret does not leave the keyring.
const keyringService, keyringUser = "NextStickies", "settings-key"

func secretKey(create bool) ([]byte, error) {
	encoded, err := keyring.Get(keyringService, keyringUser)
	if errors.Is(err, keyring.ErrNotFound) && create {
		key := make([]byte, 32)
		rand.Read(key)
		encoded = base64.StdEncoding.EncodeToString(key)
		err = keyring.Set(keyringService, keyringUser, encoded)
	}
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(encoded)
}

func gcm(create bool) (cipher.AEAD, error) {
	key, err := secretKey(create)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func protect(password string) (string, error) {
	aead, err := gcm(true)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(password), nil)), nil
}

func unprotect(blob string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		return "", err
	}
	aead, err := gcm(false)
	if err != nil {
		return "", err
	}
	if len(data) < aead.NonceSize() {
		return "", errors.New("invalid password blob")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], nil)
	return string(plain), err
}

// decryptElectron: Electron's Linux safeStorage key sits in the keyring under Chromium's own schema, which is not
// worth reimplementing; the user re-enters the app password once.
func decryptElectron(string, string) (string, error) {
	return "", errors.New("Electron safeStorage is not readable on Linux")
}
