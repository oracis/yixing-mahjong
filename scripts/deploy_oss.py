#!/usr/bin/env python3
"""Deploy static files to Alibaba Cloud OSS.

Used both for local one-off deploys and by GitHub Actions.
All configuration comes from environment variables (never hardcoded):

  OSS_ACCESS_KEY_ID      (required)
  OSS_ACCESS_KEY_SECRET  (required)
  OSS_BUCKET             (required) e.g. yixing-mahjong-hk
  OSS_REGION             (required) e.g. cn-hongkong
  OSS_ENDPOINT           (optional) override endpoint

Usage:
  python scripts/deploy_oss.py                 # upload index.html (bucket must exist)
  python scripts/deploy_oss.py --create        # also create bucket + website hosting
  python scripts/deploy_oss.py --file a.html --file b.js
  python scripts/deploy_oss.py --dir dist
  python scripts/deploy_oss.py --verify         # anonymous curl check after upload
"""
import os
import sys
import argparse
import mimetypes
import subprocess

try:
    import oss2
    from oss2.models import BucketWebsite
except ImportError:
    sys.exit("oss2 is not installed. Run: pip install oss2")

CONTENT_TYPE = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
    ".xml": "application/xml",
}

HTML_CACHE = "no-cache"
STATIC_CACHE = "public, max-age=300"


def env_or_die(name, fallback=None):
    v = os.environ.get(name)
    if not v and fallback:
        v = os.environ.get(fallback)
    if not v:
        tried = name + (f" / {fallback}" if fallback else "")
        sys.exit(f"ERROR: environment variable {tried} is not set")
    return v


def endpoint_of(region, endpoint=None):
    return endpoint or f"https://oss-{region}.aliyuncs.com"


def make_auth():
    return oss2.Auth(
        env_or_die("OSS_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_ID"),
        env_or_die("OSS_ACCESS_KEY_SECRET", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"))


def create_bucket(bucket, region, endpoint=None):
    ep = endpoint_of(region, endpoint)
    auth = make_auth()
    b = oss2.Bucket(auth, ep, bucket)
    try:
        b.create_bucket(oss2.BUCKET_ACL_PUBLIC_READ)
        print(f"[ok] created bucket '{bucket}' with public-read ACL")
    except oss2.exceptions.BucketAlreadyOwnedByYou:
        print(f"[ok] bucket '{bucket}' already owned by you")
    except oss2.exceptions.BucketAlreadyExists:
        sys.exit(f"ERROR: bucket name '{bucket}' is occupied by someone else; pick another")
    except Exception as e:
        sys.exit(f"ERROR: failed to create bucket: {e}")

    # OSS blocks anonymous reads by default at the bucket level.
    try:
        b.delete_bucket_public_access_block()
        print("[ok] disabled bucket-level BlockPublicAccess")
    except Exception as e:
        print(f"[warn] could not delete public access block: {e}")

    try:
        b.put_bucket_acl(oss2.BUCKET_ACL_PUBLIC_READ)
        print("[ok] ensured public-read ACL")
    except Exception as e:
        print(f"[warn] put_bucket_acl: {e}")

    try:
        b.put_bucket_website(BucketWebsite(index_file="index.html",
                                           error_file="index.html"))
        print("[ok] static website hosting enabled (index/error -> index.html)")
    except Exception as e:
        print(f"[warn] put_bucket_website: {e}")
    return b


def build_bucket(bucket, region, endpoint=None):
    return oss2.Bucket(make_auth(), endpoint_of(region, endpoint), bucket)


def upload_file(bucket, local_path, object_key):
    ext = os.path.splitext(local_path)[1].lower()
    ct = CONTENT_TYPE.get(ext) or mimetypes.guess_type(local_path)[0] \
        or "application/octet-stream"
    cache = HTML_CACHE if ext == ".html" else STATIC_CACHE
    with open(local_path, "rb") as fh:
        bucket.put_object(object_key, fh,
                          headers={"Content-Type": ct, "Cache-Control": cache})
    size = os.path.getsize(local_path)
    print(f"[ok] put {object_key} ({ct}, {size} bytes)")


def collect_files(args):
    files = []
    for f in args.file or []:
        if not os.path.isfile(f):
            sys.exit(f"ERROR: --file not found: {f}")
        key = os.path.basename(os.path.normpath(f))
        files.append((f, key))
    if args.dir:
        if not os.path.isdir(args.dir):
            sys.exit(f"ERROR: --dir not found: {args.dir}")
        skip = {".git", ".github", "__pycache__", ".venv", "node_modules"}
        for root, dirs, names in os.walk(args.dir):
            dirs[:] = [d for d in dirs if d not in skip]
            for n in names:
                full = os.path.join(root, n)
                rel = os.path.relpath(full, args.dir).replace(os.sep, "/")
                files.append((full, rel))
    if not files:
        if getattr(args, "verify", False):
            return []  # verify-only mode: do not upload anything
        # default: upload index.html from current working dir
        if os.path.isfile("index.html"):
            files.append(("index.html", "index.html"))
        else:
            sys.exit("ERROR: no files to upload (use --file/--dir or place index.html in CWD)")
    return files


def verify(bucket, region, endpoint=None):
    url = f"https://{bucket}.oss-{region}.aliyuncs.com/index.html"
    print(f"[verify] GET {url} (anonymous, no proxy)")
    try:
        out = subprocess.run(
            ["curl", "-s", "--noproxy", "*", "-o", "/tmp/oss_verify.html",
             "-w", "%{http_code}", url],
            capture_output=True, text=True, timeout=30,
        )
        code = out.stdout.strip()
        print(f"[verify] HTTP {code}")
        if code != "200":
            sys.exit(f"ERROR: public access returned {code}, not 200")
        with open("/tmp/oss_verify.html", "rb") as fh:
            head = fh.read(200)
        if head.lstrip().startswith(b"<?xml"):
            sys.exit("ERROR: root returned XML listing -> static website hosting not effective")
        print("[ok] public index.html served (not XML), deploy verified")
    except Exception as e:
        sys.exit(f"ERROR: verify failed: {e}")


def main():
    ap = argparse.ArgumentParser(description="Deploy static files to Aliyun OSS")
    ap.add_argument("--bucket")
    ap.add_argument("--region")
    ap.add_argument("--endpoint")
    ap.add_argument("--create", action="store_true",
                    help="create bucket + website hosting if not present")
    ap.add_argument("--file", action="append", help="file to upload (repeatable)")
    ap.add_argument("--dir", help="upload every file under this directory")
    ap.add_argument("--verify", action="store_true", help="anonymous curl check")
    args = ap.parse_args()

    bucket = args.bucket or os.environ.get("OSS_BUCKET") or env_or_die("OSS_BUCKET")
    region = args.region or os.environ.get("OSS_REGION") or env_or_die("OSS_REGION")
    endpoint = args.endpoint or os.environ.get("OSS_ENDPOINT")

    files = collect_files(args)
    need_bucket = args.create or bool(files)
    if args.create:
        create_bucket(bucket, region, endpoint)
    b = build_bucket(bucket, region, endpoint) if need_bucket else None

    for local, key in files:
        upload_file(b, local, key)

    if args.verify:
        verify(bucket, region, endpoint)

    print(f"\nDONE. Site URL: https://{bucket}.oss-{region}.aliyuncs.com/")


if __name__ == "__main__":
    main()
