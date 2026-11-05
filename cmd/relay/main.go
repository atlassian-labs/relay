package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

var Version = "dev"

// Distribution names the channel this shim ships through. Atlas CLI plugin
// builds keep the default; public release archives set it to "github" so the
// app does not treat them as Atlas-managed installs.
var Distribution = "atlas"

const atlasPluginVersionEnv = "RELAY_ATLAS_PLUGIN_VERSION"

func childEnv(relayName string) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		// A public build must never inherit an Atlas marker from a parent process.
		if Distribution != "atlas" && strings.HasPrefix(entry, atlasPluginVersionEnv+"=") {
			continue
		}
		env = append(env, entry)
	}
	env = append(env,
		"RELAY_RELEASE_VERSION="+Version,
		"RELAY_ATLAS_PLUGIN_SHIM="+relayName,
	)
	if Distribution == "atlas" {
		env = append(env, atlasPluginVersionEnv+"="+Version)
	}
	return env
}

func main() {
	assets := os.Getenv("ATLAS_PLUGIN_ASSETS")
	if assets == "" {
		fmt.Fprintln(os.Stderr, "relay: ATLAS_PLUGIN_ASSETS is not set")
		os.Exit(1)
	}

	bunName := "bun"
	relayName := "relay"
	if runtime.GOOS == "windows" {
		bunName = "bun.exe"
		relayName = "relay.exe"
	}

	bunPath := filepath.Join(assets, "bin", bunName)
	entrypoint := filepath.Join(assets, "app", "dist", "index.js")
	if _, err := os.Stat(bunPath); err != nil {
		fmt.Fprintf(os.Stderr, "relay: bundled Bun runtime not found at %s: %v\n", bunPath, err)
		os.Exit(1)
	}
	if _, err := os.Stat(entrypoint); err != nil {
		fmt.Fprintf(os.Stderr, "relay: bundled app entrypoint not found at %s: %v\n", entrypoint, err)
		os.Exit(1)
	}
	args := append([]string{entrypoint}, os.Args[1:]...)
	cmd := exec.Command(bunPath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = childEnv(relayName)

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
				os.Exit(status.ExitStatus())
			}
		}
		fmt.Fprintf(os.Stderr, "relay: failed to run bundled app: %v\n", err)
		os.Exit(1)
	}
}
