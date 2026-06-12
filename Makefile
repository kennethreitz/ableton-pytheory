# ableton-pytheory — pytheory inside Ableton Live.
#
# `make run` builds the extension and launches Live's Extension Host
# against it (Developer Mode must be enabled in Live's preferences).

LIVE_APP ?= /Applications/Ableton Live 12 Beta.app

.PHONY: all run build package install clean

all: run

node_modules: package.json
	npm install
	@touch node_modules

run: node_modules
	npm start

# Override the Live app from .env, e.g.: make run-live LIVE_APP="/Applications/Ableton Live 12.app"
run-live: node_modules
	npm run build:dev && npx extensions-cli run \
		--live "$(LIVE_APP)" \
		--storage-directory .dev/storage \
		--temp-directory .dev/tmp

build: node_modules
	npm run build

package: node_modules
	npm run package

clean:
	rm -rf dist .dev *.ablx
