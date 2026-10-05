# Builds the tax intake demo two ways: inline SDK (one file to share) and linked SDK (for the repo, next to tcxp.js).
import os
d = os.path.dirname(os.path.abspath(__file__))
r = lambda p: open(os.path.join(d, p), encoding='utf-8').read()
shell, js = r('shell.html'), r('demo.js')
sdk = open(os.path.join(d, '..', 'tcxp.js'), encoding='utf-8').read()
assert '</script' not in js.lower() and '</script' not in sdk.lower()
def page(sdk_tag):
    body = shell.replace('<!--SDK-->', sdk_tag, 1).replace('/*DEMO*/', js, 1)
    return body
inline = page('<script>\n' + sdk + '\n</script>')
linked = page('<script src="tcxp.js"></script>')
open(os.path.join(d, 'tax-intake.artifact.html'), 'w', encoding='utf-8').write(inline)
full = lambda b: ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                  + b.replace('<div class="app">', '</head>\n<body>\n<div class="app">', 1) + '\n</body>\n</html>\n')
open(os.path.join(d, 'tax-intake.html'), 'w', encoding='utf-8').write(full(inline))
open(os.path.join(d, 'tax-intake.repo.html'), 'w', encoding='utf-8').write(full(linked))
print('built', len(inline), len(linked))
