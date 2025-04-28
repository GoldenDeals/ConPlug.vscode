.PHONY: install compile watch package clean debug lint

install:
	npm install

compile:
	npm run compile

watch:
	npm run watch

package:
	npm run package

clean:
	rm -rf out
	rm -f *.vsix

debug: compile
	code --extensionDevelopmentPath=$$PWD .

lint:
	npm run lint

all: clean install compile package