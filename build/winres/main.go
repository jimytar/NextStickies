// Writes the Windows resources linked into NextStickies.exe: app icon, version info and manifest.
//
//	go run ./build/winres <version> <out.syso>
package main

import (
	"fmt"
	"os"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: winres <version> <out.syso>")
		os.Exit(2)
	}
	if err := write(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func write(ver, out string) error {
	f, err := os.Open("build/icon.ico")
	if err != nil {
		return err
	}
	defer f.Close()
	icon, err := winres.LoadICO(f)
	if err != nil {
		return err
	}
	rs := winres.ResourceSet{}
	// ID 3 is the icon Wails loads for its windows; the lowest ID is also what Explorer shows for the exe.
	if err := rs.SetIcon(winres.ID(3), icon); err != nil {
		return err
	}
	rs.SetManifest(winres.AppManifest{
		DPIAwareness:        winres.DPIPerMonitorV2,
		UseCommonControlsV6: true,
	})
	var vi version.Info
	vi.SetFileVersion(ver)
	vi.SetProductVersion(ver)
	for k, v := range map[string]string{
		version.ProductName:      "NextStickies",
		version.FileDescription:  "NextStickies",
		version.CompanyName:      "jimytar",
		version.LegalCopyright:   "MIT License",
		version.OriginalFilename: "NextStickies.exe",
	} {
		if err := vi.Set(version.LangDefault, k, v); err != nil {
			return err
		}
	}
	rs.SetVersionInfo(vi)
	o, err := os.Create(out)
	if err != nil {
		return err
	}
	defer o.Close()
	return rs.WriteObject(o, winres.ArchAMD64)
}
