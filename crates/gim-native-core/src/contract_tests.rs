use super::*;
use serde::{Serialize, de::DeserializeOwned};

fn round_trip<T: Serialize + DeserializeOwned>(value: &serde_json::Value) {
    let data:T=serde_json::from_value(value.clone()).unwrap();
    assert_eq!(&serde_json::to_value(data).unwrap(),value);
}
#[test]
fn native_contract_fixtures_round_trip_without_losing_raw_values() {
    let fixtures:serde_json::Value=serde_json::from_str(include_str!("../../../contracts/native-v1.fixtures.json")).unwrap();
    let data=&fixtures["types"];
    round_trip::<FamPropertyPayload>(&data["FamPropertyPayload"]);
    round_trip::<DevPropertyPayload>(&data["DevPropertyPayload"]);
    round_trip::<FamPropertyRecord>(&data["FamPropertyRecord"]);
    round_trip::<DevPropertyRecord>(&data["DevPropertyRecord"]);
    round_trip::<LineFamPropertyPayload>(&data["LineFamPropertyPayload"]);
    round_trip::<LineDevPropertyPayload>(&data["LineDevPropertyPayload"]);
    round_trip::<LineFamPropertyRecord>(&data["LineFamPropertyRecord"]);
    round_trip::<LineDevPropertyRecord>(&data["LineDevPropertyRecord"]);
    for value in fixtures["errors"].as_array().unwrap() {round_trip::<NativeError>(value);}
}
#[test]
fn native_contract_rejects_missing_required_nullable_and_unknown_fields() {
    let valid=serde_json::json!({"dev_path":"DEV/a.dev","prop_key":"NAME","prop_value":null});
    assert!(serde_json::from_value::<DevPropertyPayload>(valid.clone()).is_ok());
    let mut missing=valid.clone();missing.as_object_mut().unwrap().remove("prop_value");
    assert!(serde_json::from_value::<DevPropertyPayload>(missing).is_err());
    let mut unknown=valid;unknown["legacy"]=true.into();
    assert!(serde_json::from_value::<DevPropertyPayload>(unknown).is_err());
    assert!(serde_json::from_value::<NativeError>(serde_json::json!({"code":"UNKNOWN","message":"x"})).is_err());
}
