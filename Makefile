SCHEMA_DIR = schemas

.PHONY: schemas test

## Compile GSettings schemas after editing the XML
schemas:
	glib-compile-schemas $(SCHEMA_DIR)

## Run all tests
test:
	gjs -m tests/test-recorder.js
	gjs -m tests/test-ai.js
	gjs -m tests/test-keybinding.js
