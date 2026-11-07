//! Own-process-tree sampler, independent of WebView event-loop responsiveness.
#[cfg(windows)]
#[path = "../src/windows_process_tree.rs"]
mod windows_process_tree;

#[cfg(windows)]
fn main() {
    use std::{ffi::c_void,io::{self,BufRead,Write},sync::mpsc,time::{Duration,Instant}};
    #[link(name="kernel32")]
    extern "system" {
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut c_void;
        fn WaitForSingleObject(handle:*mut c_void,ms:u32)->u32;
        fn CloseHandle(handle:*mut c_void)->i32;
        fn QueryFullProcessImageNameW(handle:*mut c_void,flags:u32,name:*mut u16,size:*mut u32)->i32;
    }
    let args:Vec<String>=std::env::args().collect();
    let pid:u32=args.get(1).and_then(|value|value.parse().ok()).expect("owned root PID required");
    let expected=args.get(2).expect("owned executable required").replace('/',"\\").to_lowercase();
    // Hold the root handle throughout sampling, preventing PID reuse ambiguity.
    let handle=unsafe{OpenProcess(0x0010_1000,0,pid)};
    if handle.is_null(){return}
    let mut name=[0u16;32768];let mut len=name.len() as u32;
    let matched=unsafe{QueryFullProcessImageNameW(handle,0,name.as_mut_ptr(),&mut len)}!=0
        &&String::from_utf16_lossy(&name[..len as usize]).to_lowercase()==expected;
    if !matched{unsafe{CloseHandle(handle);}return}
    let (send,receive)=mpsc::channel();
    std::thread::spawn(move||{for line in io::stdin().lock().lines(){let Ok(value)=line else{break};if send.send(value).is_err(){break}}});
    let origin=Instant::now();let mut checkpoint="start".to_string();
    loop {
        if unsafe{WaitForSingleObject(handle,0)}!=258{break}
        let started=Instant::now();let sample=windows_process_tree::snapshot(pid);
        let row=serde_json::json!({"scope":"process-tree","method":"native-independent-private-bytes","quality":"runtime-sampled",
            "availability":if sample.available{"available"}else{"unavailable"},"bytes":sample.private_bytes,"workingSetBytes":sample.rss_bytes,
            "processCount":sample.process_count,"reason":sample.reason,"source":sample.source,"atMs":origin.elapsed().as_secs_f64()*1000.0,
            "sampleDelayMs":started.elapsed().as_secs_f64()*1000.0,"clockId":"native-sampler","checkpoint":checkpoint});
        if writeln!(io::stdout(),"{}",row).is_err(){break}let _=io::stdout().flush();
        match receive.recv_timeout(Duration::from_secs(1)){
            Ok(value) if value=="stop"=>break,
            Ok(value)=>checkpoint=value,
            Err(mpsc::RecvTimeoutError::Timeout)=>checkpoint="periodic".into(),
            Err(_)=>break,
        }
    }
    unsafe{CloseHandle(handle);}
}

#[cfg(not(windows))]
fn main(){println!("{{\"availability\":\"unsupported\",\"bytes\":null,\"reason\":\"windows-required\"}}");}
