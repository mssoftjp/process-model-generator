#!/usr/bin/env python3
# 原本 .bpmn を bpmn-js(公式ビューア)+原本 DI でレンダリングする HTML を生成
import base64
import hashlib
import json
import sys

BPMN_JS_URL = "https://unpkg.com/bpmn-js@17.11.1/dist/bpmn-navigated-viewer.production.min.js"
BPMN_JS_SRI = "sha384-izUzsqBpTLenW0ylFgbiLMoW5T0/fTAi+oOM/yuwnzOZAc8OFynG1LHJGsCWEP4G"
STYLE = "html,body,#c{margin:0;width:100%;height:100%;background:#fff}"


def sha256_source(text):
    digest = hashlib.sha256(text.encode()).digest()
    return "'sha256-" + base64.b64encode(digest).decode() + "'"


xml = open(sys.argv[1]).read()
safe_xml = json.dumps(xml).replace("<", "\\u003c")
script = f"""const xml = {safe_xml};
const v = new BpmnJS({{ container: '#c' }});
v.importXML(xml).then(() => v.get('canvas').zoom('fit-viewport'));"""
inline_script = f"\n{script}\n"
csp = "; ".join([
    "default-src 'none'",
    f"script-src {BPMN_JS_URL} {sha256_source(inline_script)}",
    f"style-src {sha256_source(STYLE)}",
    "img-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
])
html = f'''<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<style>{STYLE}</style>
<script src="{BPMN_JS_URL}" integrity="{BPMN_JS_SRI}" crossorigin="anonymous"></script>
</head><body><div id="c"></div><script>{inline_script}</script></body></html>'''
open(sys.argv[2], 'w').write(html)
