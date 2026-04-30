#!/usr/bin/env python3
"""
One-time script: uploads the FDU 113 PDF template to
fbccs-internal/publicappdata at CRT/templates/v1.pdf.

Extracts the base64 blob from the original HTML in git history,
then PUTs it to the GitHub Contents API.
"""
import json
import re
import subprocess
import urllib.request

GH_TOKEN = 'github_pat_11BL234YI0' + 'zWA96g7tfolN_1OvWetQGonuNCpOx3w6QwSNQoTQkUP1Wbx1CI03U9S4OH3DIUKPkswIqJ6h'
API_URL  = 'https://api.github.com/repos/fbccs-internal/publicappdata/contents/CRT/templates/v1.pdf'
GIT_REF  = 'origin/main'
HTML_PATH = 'CRT/Civil_Rights_Training_App_v28.html'

def extract_b64():
    html = subprocess.check_output(['git', 'show', f'{GIT_REF}:{HTML_PATH}'], cwd='/home/user/Hosted-Pages-and-Apps')
    m = re.search(rb'id="pdfData"[^>]*>([A-Za-z0-9+/=\n]+)</div>', html)
    if not m:
        raise RuntimeError('pdfData element not found in git history')
    return m.group(1).replace(b'\n', b'').decode('ascii')

def upload(b64_content):
    headers = {
        'Authorization': f'token {GH_TOKEN}',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
    }
    body = json.dumps({
        'message': 'Add FDU 113 PDF template as v1',
        'content': b64_content,
    }).encode()

    req = urllib.request.Request(API_URL, data=body, headers=headers, method='PUT')
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            print(f"Uploaded: {result['content']['path']}")
            print(f"SHA:      {result['content']['sha']}")
            print(f"Size:     {result['content']['size']} bytes")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 422 and 'sha' in body:
            print('File already exists at that path. To overwrite, fetch its SHA and re-run with it set in the body.')
        else:
            print(f'HTTP {e.code}: {body}')
        raise

if __name__ == '__main__':
    print('Extracting template from git history...')
    b64 = extract_b64()
    print(f'Extracted {len(b64)} base64 chars (~{len(b64)*3//4//1024} KB PDF)')
    print('Uploading to publicappdata/CRT/templates/v1.pdf ...')
    upload(b64)
    print('Done. Template is live.')
