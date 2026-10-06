"""Remove one guard at a time in isolated copies and require its fixture to fail."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/lib/template-provenance.py"
MUTATIONS = [
    ("source-subdirectory", '"ls-tree", "--full-tree", ', '"ls-tree", ',
     "test_source_subdirectory_preserves_full_commit_tree"),
    ("snapshot-revision", 'revision = commit(repo, revision)\n    entries = []',
     'revision = commit(repo, "HEAD")\n    entries = []',
     "test_committed_snapshot_and_same_commit_metadata"),
    ("existing-output", 'if os.path.lexists(output):', 'if False:',
     "test_existing_destinations_are_unchanged"),
    ("schema", 'if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:',
     'if False:', "test_metadata_invalid_cases"),
    ("metadata-symlink", 'if parts[0].casefold() == ".template-version":', 'if False:',
     "test_snapshot_metadata_symlink_cannot_write_outside"),
    ("lazy-fetch", 'GIT_NO_LAZY_FETCH="1"', 'GIT_NO_LAZY_FETCH="0"',
     "test_missing_promisor_blob_does_not_lazy_fetch"),
    ("external-diff", '"--no-ext-diff", ', '',
     "test_comparison_read_only_no_network_or_external_diff"),
]


def main():
    results = []
    for name, old, new, fixture in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix="provenance-regression-") as temp:
            root = Path(temp)
            for relative in ("scripts/lib", "tests"):
                (root / relative).mkdir(parents=True)
            for relative in ("scripts/new-project.sh", "scripts/template-diff.sh", "tests/template-provenance.py"):
                shutil.copy2(ROOT / relative, root / relative)
            content = SOURCE.read_text()
            if content.count(old) != 1:
                raise AssertionError("mutation anchor changed: " + name)
            content = content.replace(old, new)
            if name == "existing-output":
                content = content.replace("output.mkdir()", "output.mkdir(exist_ok=True)")
            (root / "scripts/lib/template-provenance.py").write_text(content)
            result = subprocess.run([sys.executable, str(root / "tests/template-provenance.py"),
                                     "Provenance." + fixture], capture_output=True, text=True)
            detected = result.returncode != 0 and "FAIL:" in result.stderr
            results.append(dict(mutation=name, fixture=fixture, detected=detected,
                                returncode=result.returncode, diagnostics=result.stderr))
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(item["detected"] for item in results) else 1


if __name__ == "__main__":
    sys.exit(main())
