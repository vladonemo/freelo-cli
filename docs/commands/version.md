# `freelo --version`

Print the installed version of the Freelo CLI.

## Synopsis

```
freelo --version
freelo -V
```

## Description

Both `--version` and the Commander-conventional short form `-V` print the version recorded in the published package's `package.json`, then exit 0.

The version string is inlined into the bundled binary at build time, so the output is guaranteed to match the installed package — no fallback to a globally-resolved `package.json` and no surprises when invoked through symlinks or `npx`.

## Examples

```bash
$ freelo --version
0.0.0
```

```bash
$ freelo -V
0.0.0
```

## Exit codes

| Code | Meaning         |
| ---- | --------------- |
| 0    | Version printed |
