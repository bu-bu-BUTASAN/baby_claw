#[test_only]
module baby_claw::ledger_tests;

use baby_claw::ledger::{Self, Profile};
use std::unit_test::assert_eq;
use sui::clock;
use sui::test_scenario;

const OWNER: address = @0xA11CE;
const OTHER: address = @0xB0B;
const CREATED_AT_MS: u64 = 123456789;
const RECORD_CREATED_AT_MS: u64 = 987654321;

#[test]
fun mint_profile_creates_owner_profile() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clock, CREATED_AT_MS);

    ledger::mint_profile(&clock, scenario.ctx());
    clock::destroy_for_testing(clock);

    scenario.next_tx(OWNER);
    {
        let profile = scenario.take_from_sender<Profile>();
        assert_eq!(ledger::profile_owner(&profile), OWNER);
        assert_eq!(ledger::profile_next_seq(&profile), 0);
        assert_eq!(ledger::profile_schema_version(&profile), 1);
        assert_eq!(ledger::profile_created_at_ms(&profile), CREATED_AT_MS);
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test]
fun add_record_succeeds_and_increments_sequence() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        add_sample_record(&mut profile, scenario.ctx(), 10);

        assert_eq!(ledger::profile_next_seq(&profile), 1);
        assert!(ledger::record_exists(&profile, 0));
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test]
fun two_records_use_separate_dynamic_fields() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        add_sample_record(&mut profile, scenario.ctx(), 10);
        add_sample_record(&mut profile, scenario.ctx(), 11);

        assert_eq!(ledger::profile_next_seq(&profile), 2);
        assert!(ledger::record_exists(&profile, 0));
        assert!(ledger::record_exists(&profile, 1));
        assert_eq!(ledger::record_seq(&profile, 0), 0);
        assert_eq!(ledger::record_seq(&profile, 1), 1);
        assert!(ledger::record_payload_blob_id(&profile, 0) == vector[1, 2, 10]);
        assert!(ledger::record_payload_blob_id(&profile, 1) == vector[1, 2, 11]);
        assert!(ledger::record_payload_hash(&profile, 0) == vector[4, 5, 10]);
        assert!(ledger::record_payload_hash(&profile, 1) == vector[4, 5, 11]);
        assert!(ledger::record_commitment(&profile, 0) == vector[7, 8, 10]);
        assert!(ledger::record_commitment(&profile, 1) == vector[7, 8, 11]);
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ledger::E_NOT_OWNER)]
fun non_owner_add_record_aborts() {
    let mut scenario = mint_profile_for_owner();

    scenario.next_tx(OTHER);
    {
        let mut profile = scenario.take_from_address<Profile>(OWNER);
        add_sample_record(&mut profile, scenario.ctx(), 10);
        test_scenario::return_to_address(OWNER, profile);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ledger::E_EMPTY_PAYLOAD_BLOB_ID)]
fun empty_payload_blob_id_aborts() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        ledger::add_record(
            &mut profile,
            vector[],
            vector[4, 5, 6],
            vector[7, 8, 9],
            RECORD_CREATED_AT_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ledger::E_EMPTY_PAYLOAD_HASH)]
fun empty_payload_hash_aborts() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        ledger::add_record(
            &mut profile,
            vector[1, 2, 3],
            vector[],
            vector[7, 8, 9],
            RECORD_CREATED_AT_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ledger::E_EMPTY_RECORD_COMMITMENT)]
fun empty_record_commitment_aborts() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        ledger::add_record(
            &mut profile,
            vector[1, 2, 3],
            vector[4, 5, 6],
            vector[],
            RECORD_CREATED_AT_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

#[test]
fun record_getters_return_stored_metadata() {
    let mut scenario = mint_profile_for_owner();

    {
        let mut profile = scenario.take_from_sender<Profile>();
        add_sample_record(&mut profile, scenario.ctx(), 42);

        assert_eq!(ledger::record_seq(&profile, 0), 0);
        assert!(ledger::record_payload_blob_id(&profile, 0) == vector[1, 2, 42]);
        assert!(ledger::record_payload_hash(&profile, 0) == vector[4, 5, 42]);
        assert!(ledger::record_commitment(&profile, 0) == vector[7, 8, 42]);
        assert_eq!(ledger::record_created_at_ms(&profile, 0), RECORD_CREATED_AT_MS);
        assert_eq!(ledger::record_schema_version(&profile, 0), 1);
        scenario.return_to_sender(profile);
    };

    scenario.end();
}

fun mint_profile_for_owner(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(OWNER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clock, CREATED_AT_MS);
    ledger::mint_profile(&clock, scenario.ctx());
    clock::destroy_for_testing(clock);
    scenario.next_tx(OWNER);
    scenario
}

fun add_sample_record(profile: &mut Profile, ctx: &mut TxContext, marker: u8) {
    ledger::add_record(
        profile,
        vector[1, 2, marker],
        vector[4, 5, marker],
        vector[7, 8, marker],
        RECORD_CREATED_AT_MS,
        ctx,
    );
}
