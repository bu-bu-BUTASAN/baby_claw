module baby_claw::ledger;

use sui::clock::{Self, Clock};
use sui::dynamic_field;

const SCHEMA_VERSION: u16 = 1;

const E_NOT_OWNER: u64 = 0;
const E_EMPTY_PAYLOAD_BLOB_ID: u64 = 1;
const E_EMPTY_PAYLOAD_HASH: u64 = 2;
const E_EMPTY_RECORD_COMMITMENT: u64 = 3;

public struct Profile has key {
    id: UID,
    owner: address,
    next_seq: u64,
    schema_version: u16,
    created_at_ms: u64,
}

public struct RecordKey has copy, drop, store {
    seq: u64,
}

public struct Record has store {
    seq: u64,
    payload_blob_id: vector<u8>,
    payload_hash: vector<u8>,
    record_commitment: vector<u8>,
    created_at_bucket: u64,
    schema_version: u16,
}

public fun mint_profile(clock: &Clock, ctx: &mut TxContext) {
    let sender = tx_context::sender(ctx);
    let profile = Profile {
        id: object::new(ctx),
        owner: sender,
        next_seq: 0,
        schema_version: SCHEMA_VERSION,
        created_at_ms: clock::timestamp_ms(clock),
    };
    transfer::transfer(profile, sender);
}

public fun add_record(
    profile: &mut Profile,
    payload_blob_id: vector<u8>,
    payload_hash: vector<u8>,
    record_commitment: vector<u8>,
    created_at_bucket: u64,
    ctx: &mut TxContext,
) {
    assert!(profile.owner == tx_context::sender(ctx), E_NOT_OWNER);
    assert!(!payload_blob_id.is_empty(), E_EMPTY_PAYLOAD_BLOB_ID);
    assert!(!payload_hash.is_empty(), E_EMPTY_PAYLOAD_HASH);
    assert!(!record_commitment.is_empty(), E_EMPTY_RECORD_COMMITMENT);

    let seq = profile.next_seq;
    let record = Record {
        seq,
        payload_blob_id,
        payload_hash,
        record_commitment,
        created_at_bucket,
        schema_version: SCHEMA_VERSION,
    };

    dynamic_field::add(&mut profile.id, RecordKey { seq }, record);
    profile.next_seq = seq + 1;
}

#[test_only]
public fun profile_owner(profile: &Profile): address {
    profile.owner
}

#[test_only]
public fun profile_next_seq(profile: &Profile): u64 {
    profile.next_seq
}

#[test_only]
public fun profile_schema_version(profile: &Profile): u16 {
    profile.schema_version
}

#[test_only]
public fun profile_created_at_ms(profile: &Profile): u64 {
    profile.created_at_ms
}

#[test_only]
public fun record_exists(profile: &Profile, seq: u64): bool {
    dynamic_field::exists_with_type<RecordKey, Record>(&profile.id, RecordKey { seq })
}

#[test_only]
public fun record_seq(profile: &Profile, seq: u64): u64 {
    borrow_record(profile, seq).seq
}

#[test_only]
public fun record_payload_blob_id(profile: &Profile, seq: u64): vector<u8> {
    borrow_record(profile, seq).payload_blob_id.map_ref!(|byte| *byte)
}

#[test_only]
public fun record_payload_hash(profile: &Profile, seq: u64): vector<u8> {
    borrow_record(profile, seq).payload_hash.map_ref!(|byte| *byte)
}

#[test_only]
public fun record_commitment(profile: &Profile, seq: u64): vector<u8> {
    borrow_record(profile, seq).record_commitment.map_ref!(|byte| *byte)
}

#[test_only]
public fun record_created_at_bucket(profile: &Profile, seq: u64): u64 {
    borrow_record(profile, seq).created_at_bucket
}

#[test_only]
public fun record_schema_version(profile: &Profile, seq: u64): u16 {
    borrow_record(profile, seq).schema_version
}

#[test_only]
fun borrow_record(profile: &Profile, seq: u64): &Record {
    dynamic_field::borrow<RecordKey, Record>(&profile.id, RecordKey { seq })
}
