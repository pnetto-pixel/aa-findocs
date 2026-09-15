import assert from "node:assert/strict";
import { extrasFromSnapshotForRestore } from "../src/lib/contributionExtras.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log("contribution extras restore");

test("restores a Redis snapshot only when the extras field was absent", () => {
  assert.deepEqual(
    extrasFromSnapshotForRestore({
      extrasWerePersisted: false,
      snapshotExtras: [{ name: "BRK.B Sale", amount: 3500 }],
    }),
    [{ label: "BRK.B Sale", value: "3500" }],
  );
});

test("does not resurrect deleted extras when an empty array was persisted", () => {
  assert.equal(
    extrasFromSnapshotForRestore({
      extrasWerePersisted: true,
      snapshotExtras: [{ name: "BRK.B Sale", amount: 3500 }],
    }),
    null,
  );
});

test("does not overwrite locally persisted extras", () => {
  assert.equal(
    extrasFromSnapshotForRestore({
      extrasWerePersisted: true,
      snapshotExtras: [{ name: "Old extra", amount: 100 }],
    }),
    null,
  );
});

test("does nothing when the snapshot has no extras", () => {
  assert.equal(
    extrasFromSnapshotForRestore({ extrasWerePersisted: false, snapshotExtras: [] }),
    null,
  );
  assert.equal(
    extrasFromSnapshotForRestore({ extrasWerePersisted: false, snapshotExtras: undefined }),
    null,
  );
});

console.log(`\n${passed} contribution extras tests passed.`);

