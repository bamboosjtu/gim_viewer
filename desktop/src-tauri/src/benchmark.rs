//! Opt-in native measurement harness. Normal release has no path authorization.
use std::path::Path;
#[cfg(feature = "benchmark")]
use std::path::PathBuf;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SampleAuthorization {pub sample_id:String,pub source_path:String,pub source_sha256:String}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunManifest {
    #[serde(default)]
    pub probe_only:bool,
    pub nonce: String,
    pub sample_id: String,
    pub source_path: String,
    pub source_sha256: String,
    #[serde(default)]
    pub samples:Vec<SampleAuthorization>,
    #[cfg(feature = "benchmark")]
    pub data_root: String,
}

#[cfg(feature = "benchmark")]
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root=root.canonicalize().map_err(|_|"benchmark-root-unavailable")?;
    let path=path.canonicalize().map_err(|_|"benchmark-path-unavailable")?;
    if path == root || !path.starts_with(root) {return Err("benchmark-path-outside-workspace".into())}
    Ok(path)
}

pub(crate) fn manifest() -> Result<RunManifest,String> {
    #[cfg(feature = "benchmark")]
    {
        let root=option_env!("GIM_BENCHMARK_WORKSPACE").ok_or("benchmark-build-root-unavailable")?;
        let private=Path::new(root).join("tmp").join("gim-bench");
        let file=std::env::var("GIM_BENCHMARK_MANIFEST").map_err(|_|"benchmark-manifest-unavailable")?;
        let file=inside(&private,Path::new(&file))?;
        let data=std::fs::read(file).map_err(|_|"benchmark-manifest-unreadable")?;
        if data.len()>16384{return Err("benchmark-manifest-too-large".into())}
        let manifest:RunManifest=serde_json::from_slice(&data).map_err(|_|"benchmark-manifest-invalid")?;
        inside(&private,Path::new(&manifest.data_root))?;
        if manifest.probe_only {
            if manifest.sample_id!="capability-probe"||!manifest.source_path.is_empty()||!manifest.source_sha256.is_empty()||!manifest.samples.is_empty(){return Err("benchmark-probe-authorizes-no-source".into())}
        }else{inside(Path::new(root),Path::new(&manifest.source_path))?;}
        let mut ids=std::collections::HashSet::from([manifest.sample_id.clone()]);
        for sample in &manifest.samples{
            if !ids.insert(sample.sample_id.clone())||sample.source_sha256.len()!=64{return Err("benchmark-sample-identity-invalid".into())}
            inside(Path::new(root),Path::new(&sample.source_path))?;
        }
        if manifest.nonce.len()!=64 || (!manifest.probe_only&&manifest.source_sha256.len()!=64){return Err("benchmark-identity-invalid".into())}
        return Ok(manifest)
    }
    #[cfg(not(feature = "benchmark"))]
    Err("benchmark-build-required".into())
}

#[cfg(feature = "benchmark")]
pub(crate) fn data_root() -> Result<PathBuf,String> { Ok(PathBuf::from(manifest()?.data_root)) }

#[tauri::command]
pub(crate) fn benchmark_authorize_sample(access:tauri::State<'_,super::AuthorizedFilePaths>,sample_id:String,nonce:String)->Result<String,String>{
    let manifest=manifest()?;
    if manifest.probe_only{return Err("benchmark-probe-authorizes-no-source".into())}
    if manifest.nonce!=nonce{return Err("benchmark-authorization-mismatch".into())}
    let(path,sha)=if manifest.sample_id==sample_id{(&manifest.source_path,&manifest.source_sha256)}else{
        let sample=manifest.samples.iter().find(|row|row.sample_id==sample_id).ok_or("benchmark-authorization-mismatch")?;
        (&sample.source_path,&sample.source_sha256)
    };
    let path=Path::new(path);
    use std::io::Read;
    use sha2::{Digest,Sha256};
    let mut reader=std::io::BufReader::new(std::fs::File::open(path).map_err(|_|"benchmark-source-unavailable")?);
    let mut hash=Sha256::new();let mut buffer=[0;65536];
    loop{let count=reader.read(&mut buffer).map_err(|_|"benchmark-source-unreadable")?;if count==0{break}hash.update(&buffer[..count]);}
    if &format!("{:x}",hash.finalize())!=sha{return Err("benchmark-source-sha-mismatch".into())}
    super::authorize_selected_path(&access,path,Some("gim"))
}

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "benchmark"))]
    #[test]
    fn ordinary_build_rejects_benchmark_manifest() {
        assert_eq!(super::manifest().err().as_deref(),Some("benchmark-build-required"));
    }
    #[cfg(feature = "benchmark")]
    #[test]
    fn canonical_boundary_rejects_workspace_sibling() {
        let workspace=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let parent=workspace.join("tmp").join("benchmark-boundary-unit");
        let private=parent.join("private");
        std::fs::create_dir_all(&private).unwrap();
        let allowed=private.join("manifest.json");
        let sibling=parent.join("outside.json");
        std::fs::write(&allowed,b"{}").unwrap();std::fs::write(&sibling,b"{}").unwrap();
        assert!(super::inside(&private,&allowed).is_ok());
        assert!(super::inside(&private,&sibling).is_err());
        assert!(super::inside(&private,&private).is_err());
    }
}
