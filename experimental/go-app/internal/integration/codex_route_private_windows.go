//go:build windows

package integration

import (
	"golang.org/x/sys/windows"
	"os"
	"strings"
)

// Protect BEFORE any possibly sensitive config bytes are written. File mode
// 0600 alone does not restrict an inherited Windows DACL.
func secureRouteFile(f *os.File) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	// os.OpenFile does not request WRITE_DAC. Owner-authorized named update is
	// followed by handle-based verification; no bytes have been written yet.
	if err = windows.SetNamedSecurityInfo(f.Name(), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return err
	}
	actual, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	actualDACL, _, err := actual.DACL()
	if err != nil {
		return err
	}
	// Windows may canonicalize descriptor control flags. Verify one ACE and
	// the user-only full-control DACL, independently of D: flag spelling.
	if actualDACL == nil || actualDACL.AceCount != 1 {
		return windows.ERROR_ACCESS_DENIED
	}
	control, _, err := actual.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return windows.ERROR_ACCESS_DENIED
	}
	// Well-known user SIDs (e.g. RID500 on hosted runners) are rendered as
	// SDDL aliases. Compare OS-canonicalized desired ACE, not raw SID spelling.
	desired := sd.String()
	ace := strings.Index(desired, "(")
	if ace < 0 || !strings.HasSuffix(actual.String(), desired[ace:]) {
		return windows.ERROR_ACCESS_DENIED
	}
	return nil
}
