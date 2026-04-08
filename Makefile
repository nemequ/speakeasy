SCHEMA_DIR  = schemas
UUID        = speakeasy@speakeasy.local
EXT_DIR     = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR     = $(CURDIR)
PACK_FILE   = $(UUID).shell-extension.zip

# Trigger key used by the nested devkit session, so it doesn't fight
# the host session over the same accelerator. Override on the command
# line if you want something else: `make dev DEV_TRIGGER=F13`.
DEV_TRIGGER ?= Scroll_Lock

.PHONY: all schemas test gtk dev install uninstall pack lint logs help

all: schemas

help:
	@echo "Speakeasy Makefile targets:"
	@echo "  schemas    - Compile GSettings schemas (run after editing the XML)"
	@echo "  test       - Run all standalone unit tests under gjs"
	@echo "  gtk        - Launch the standalone GTK test app (drives the"
	@echo "               same dictation pipeline as the Shell extension,"
	@echo "               but as a normal application — debug without"
	@echo "               logging out)"
	@echo "  dev        - Launch a nested GNOME Shell devkit session for"
	@echo "               iterating without logging out. Uses '$(DEV_TRIGGER)'"
	@echo "               as the trigger key (override with DEV_TRIGGER=...)."
	@echo "  install    - Symlink this checkout into ~/.local/share/gnome-shell/extensions"
	@echo "  uninstall  - Remove the symlink (refuses to delete a non-symlink dir)"
	@echo "  pack       - Build $(PACK_FILE) for gnome-extensions install"
	@echo "  lint       - Run eslint over the JS sources (requires eslint on PATH)"
	@echo "  logs       - Tail journalctl for Speakeasy log lines"
	@echo "  help       - Show this message"

## Compile GSettings schemas after editing the XML
schemas:
	glib-compile-schemas $(SCHEMA_DIR)

## Run all tests.
test:
	gjs -m tests/test-ai.js
	gjs -m tests/test-keybinding.js
	gjs -m tests/test-session-log.js
	gjs -m tests/test-controller.js
	gjs -m tests/test-recorder-watchdog.js
	gjs -m tests/test-recorder-init.js
	gjs -m tests/test-file-transcribe.js
	gjs -m tests/test-transcript-store.js
	gjs -m tests/test-error-classifier.js
	gjs -m tests/test-path-prompt-dialog.js
	gjs -m tests/test-recovery-cleanup.js

## Launch the standalone GTK test app. Drives the same dictation
## controller as the Shell extension but in a normal Gtk.Application
## window, so the recorder + STT + AI + transcript pipeline can be
## exercised and debugged outside the compositor.
##
## Schemas are recompiled first so the app picks up any settings
## changes you've made to the XML.
gtk: schemas
	gjs -m gtk-app.js

## Launch a nested GNOME Shell session for development.
##
## Wayland does not reload extension JS on disable/enable, so the
## fastest iteration loop is to spawn a fresh nested gnome-shell each
## time. The schemas are recompiled first so any GSettings changes
## take effect on launch. Requires `mutter-devel`.
##
## The nested session uses a different trigger key than the host so
## both can coexist; override with `make dev DEV_TRIGGER=F13`.
dev: schemas
	dbus-run-session bash -c \
	  "gsettings set org.gnome.shell.extensions.speakeasy trigger-accels \"['$(DEV_TRIGGER)']\" \
	   && exec gnome-shell --devkit --wayland"

## Symlink this checkout into the user extensions directory.
##
## Idempotent: if the link already points here, do nothing. If a
## different symlink is in the way, replace it. If a real directory
## is in the way, refuse — that's almost certainly a previous
## copy-installed version and the user should remove it deliberately.
install:
	@mkdir -p "$(dir $(EXT_DIR))"
	@if [ -L "$(EXT_DIR)" ]; then \
	  target=$$(readlink "$(EXT_DIR)"); \
	  if [ "$$target" = "$(SRC_DIR)" ]; then \
	    echo "Already installed: $(EXT_DIR) -> $(SRC_DIR)"; \
	  else \
	    echo "Replacing existing symlink ($$target) -> $(SRC_DIR)"; \
	    rm "$(EXT_DIR)"; \
	    ln -s "$(SRC_DIR)" "$(EXT_DIR)"; \
	  fi; \
	elif [ -e "$(EXT_DIR)" ]; then \
	  echo "ERROR: $(EXT_DIR) exists and is not a symlink."; \
	  echo "Refusing to overwrite. Remove it manually if you really want to symlink."; \
	  exit 1; \
	else \
	  ln -s "$(SRC_DIR)" "$(EXT_DIR)"; \
	  echo "Installed: $(EXT_DIR) -> $(SRC_DIR)"; \
	fi
	@echo "Log out and back in to load the extension."

## Remove the install symlink. Refuses to delete a real directory.
uninstall:
	@if [ -L "$(EXT_DIR)" ]; then \
	  rm "$(EXT_DIR)"; \
	  echo "Removed symlink $(EXT_DIR)"; \
	elif [ -e "$(EXT_DIR)" ]; then \
	  echo "ERROR: $(EXT_DIR) is not a symlink — refusing to delete."; \
	  exit 1; \
	else \
	  echo "$(EXT_DIR) does not exist; nothing to do."; \
	fi

## Produce a zip suitable for `gnome-extensions install --force`.
##
## Includes only the runtime files — no .git, no tests, no .claude,
## no editor cruft. Schemas are compiled fresh into the bundle.
pack: schemas
	@rm -f $(PACK_FILE)
	zip -r $(PACK_FILE) \
	  metadata.json \
	  extension.js \
	  prefs.js \
	  keybinding.js \
	  recorder.js \
	  controller.js \
	  sessionLog.js \
	  transcriptStore.js \
	  fileTranscribe.js \
	  gtk-app.js \
	  ai.js \
	  ollama.js \
	  output.js \
	  utils.js \
	  stt-subprocess.js \
	  stylesheet.css \
	  schemas/org.gnome.shell.extensions.speakeasy.gschema.xml \
	  schemas/gschemas.compiled \
	  prompts \
	  ui \
	  tools \
	  COPYING \
	  README.md
	@echo "Built $(PACK_FILE)"
	@echo "Install with: gnome-extensions install --force $(PACK_FILE)"

## Run eslint over the JS sources, if eslint is on PATH.
lint:
	@if ! command -v eslint >/dev/null 2>&1; then \
	  echo "eslint not found on PATH — install it (npm i -g eslint) or skip this target."; \
	  exit 1; \
	fi
	eslint *.js ui/*.js tests/*.js

## Tail Speakeasy log lines from the user journal.
logs:
	journalctl --user -f -g Speakeasy
