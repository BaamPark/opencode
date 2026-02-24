#!/usr/bin/env python3
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

# To encrypt: python scripts/encrypt_md_with_gpg.py --source ./external --passphrase "your-passphrase" --remove-plain
# To decrypt: python scripts/encrypt_md_with_gpg.py --source ./external --passphrase "your-passphrase" --reverse

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Encrypt or decrypt Markdown files with GPG symmetric encryption.")
    parser.add_argument(
        "--source",
        default="external",
        help="Directory containing .md files (default: external)",
    )
    parser.add_argument(
        "--passphrase",
        required=True,
        help="GPG passphrase used for symmetric encryption",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Process files recursively",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing .gpg files",
    )
    parser.add_argument(
        "--remove-plain",
        action="store_true",
        help="Delete original .md files after successful encryption",
    )
    parser.add_argument(
        "--reverse",
        action="store_true",
        help="Decrypt .gpg files back to plaintext and remove .gpg files after successful decryption",
    )
    return parser.parse_args()


def find_markdown_files(root: Path, recursive: bool) -> list[Path]:
    if recursive:
        return sorted([p for p in root.rglob("*.md") if p.is_file()])
    return sorted([p for p in root.glob("*.md") if p.is_file()])


def find_encrypted_files(root: Path, recursive: bool) -> list[Path]:
    if recursive:
        return sorted([p for p in root.rglob("*.gpg") if p.is_file()])
    return sorted([p for p in root.glob("*.gpg") if p.is_file()])


def encrypt_file(filepath: Path, passphrase: str, force: bool) -> bool:
    output = filepath.with_suffix(filepath.suffix + ".gpg")
    if output.exists() and not force:
        print(f"skip: {output} already exists")
        return True

    cmd = [
        "gpg",
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        passphrase,
        "--output",
        str(output),
        str(filepath),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = (result.stderr or "").strip() or f"gpg exited with code {result.returncode}"
        print(f"error: failed to encrypt {filepath}: {err}", file=sys.stderr)
        return False

    print(f"encrypted: {filepath} -> {output}")
    return True


def decrypt_file(filepath: Path, passphrase: str, force: bool) -> bool:
    if filepath.suffix != ".gpg":
        print(f"skip: {filepath} is not a .gpg file")
        return True

    output = Path(str(filepath)[:-4])
    if output.exists() and not force:
        print(f"skip: {output} already exists")
        return True

    cmd = [
        "gpg",
        "--batch",
        "--yes",
        "--decrypt",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        passphrase,
        "--output",
        str(output),
        str(filepath),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = (result.stderr or "").strip() or f"gpg exited with code {result.returncode}"
        print(f"error: failed to decrypt {filepath}: {err}", file=sys.stderr)
        return False

    print(f"decrypted: {filepath} -> {output}")
    return True


def main() -> int:
    args = parse_args()
    if shutil.which("gpg") is None:
        print("error: gpg is not installed or not on PATH", file=sys.stderr)
        return 1

    source = Path(args.source).resolve()
    if not source.exists() or not source.is_dir():
        print(f"error: source directory not found: {source}", file=sys.stderr)
        return 1

    files = find_encrypted_files(source, recursive=args.recursive) if args.reverse else find_markdown_files(source, recursive=args.recursive)
    if not files:
        if args.reverse:
            print(f"no .gpg files found in: {source}")
        else:
            print(f"no markdown files found in: {source}")
        return 0

    ok = True
    if args.reverse:
        for file in files:
            decrypted = decrypt_file(file, args.passphrase, force=args.force)
            ok = ok and decrypted
            if decrypted:
                file.unlink(missing_ok=True)
                print(f"removed encrypted file: {file}")
    else:
        for file in files:
            encrypted = encrypt_file(file, args.passphrase, force=args.force)
            ok = ok and encrypted
            if encrypted and args.remove_plain:
                file.unlink(missing_ok=True)
                print(f"removed plaintext: {file}")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
