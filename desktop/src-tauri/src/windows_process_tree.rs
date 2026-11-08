use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const ERROR_NO_MORE_FILES: u32 = 18;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

#[repr(C)]
#[derive(Default)]
struct FileTime { low:u32, high:u32 }
struct ProcessHandle(*mut c_void);
impl Drop for ProcessHandle {fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
fn opened(pid:u32)->Result<Option<(ProcessHandle,u64)>,String>{
    let handle=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid)};
    if handle.is_null(){let error=unsafe{GetLastError()};return if error==87{Ok(None)}else{Err(format!("process-query-failed:{error}"))}}
    let handle=ProcessHandle(handle);
    let(mut created,mut exited,mut kernel,mut user)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
    if unsafe{GetProcessTimes(handle.0,&mut created,&mut exited,&mut kernel,&mut user)}==0{return Err("process-times-unavailable".into())}
    if exited.low!=0||exited.high!=0{return Ok(None)}
    Ok(Some((handle,((created.high as u64)<<32)|created.low as u64)))
}
fn owned_descendants<H>(root_pid:u32,children:&HashMap<u32,Vec<u32>>,mut open:impl FnMut(u32)->Result<Option<(H,u64)>,String>)->Result<Vec<(u32,H,u64)>,String>{
    let root=open(root_pid)?.ok_or("root-exited")?;
    let mut processes=vec![(root_pid,root.0,root.1)];let mut cursor=0;
    while cursor<processes.len(){
        let (parent,created)=(processes[cursor].0,processes[cursor].2);
        for child in children.get(&parent).into_iter().flatten(){
            if *child==parent||processes.iter().any(|(id,_,_)|id==child){continue}
            if let Some((handle,born))=open(*child)?{if born>=created{processes.push((*child,handle,born));}}
        }
        cursor+=1;
    }
    Ok(processes)
}

#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetProcessTimes(handle:*mut c_void,created:*mut FileTime,exited:*mut FileTime,kernel:*mut FileTime,user:*mut FileTime)->i32;
    fn GetExitCodeProcess(handle:*mut c_void,code:*mut u32)->i32;
}

#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut c_void,
        counters: *mut c_void,
        size: u32,
    ) -> i32;
}

pub(super) struct Snapshot {
    pub(super) rss_bytes: Option<u64>,
    pub(super) private_bytes: Option<u64>,
    pub(super) root_private_bytes: Option<u64>,
    pub(super) process_count: Option<u32>,
    pub(super) available: bool,
    pub(super) source: String,
    pub(super) reason: Option<String>,
}

fn unavailable(reason: impl Into<String>) -> Snapshot {
    Snapshot {
        rss_bytes: None,
        private_bytes: None,
        root_private_bytes: None,
        process_count: None,
        available: false,
        source: "windows-process-tree-unavailable".to_string(),
        reason: Some(reason.into()),
    }
}

fn query_rss(handle: *mut c_void) -> Option<(u64, u64)> {
    // SAFETY: the handle comes from OpenProcess and the output struct is
    // initialized to the exact shape required by GetProcessMemoryInfo.
    unsafe {
        let mut counters = ProcessMemoryCounters {
            cb: size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
            private_usage: 0,
        };
        if GetProcessMemoryInfo(handle, &mut counters as *mut _ as *mut c_void, counters.cb) != 0 {
            Some((counters.working_set_size as u64, counters.private_usage as u64))
        } else {
            None
        }
    }
}

fn unavailable_with_root(root_pid:u32,reason:String)->Snapshot{
    let root_private_bytes=opened(root_pid).ok().flatten()
        .and_then(|(handle,_)|query_rss(handle.0).map(|(_,private)|private));
    Snapshot{rss_bytes:None,private_bytes:None,root_private_bytes,process_count:None,
        available:false,source:"root-process-private-fallback".into(),reason:Some(reason)}
}

pub(super) fn snapshot(root_pid: u32) -> Snapshot {
    // SAFETY: Toolhelp32 APIs write only to the initialized entry and
    // return a handle that is closed on every completed enumeration path.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot as isize == -1 {
        return unavailable("CreateToolhelp32Snapshot-failed");
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut entry = ProcessEntry32W {
        dw_size: size_of::<ProcessEntry32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };
    let first_ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    if !first_ok {
        unsafe { CloseHandle(snapshot); }
        return unavailable("Process32FirstW-failed");
    }
    loop {
        children
            .entry(entry.th32_parent_process_id)
            .or_default()
            .push(entry.th32_process_id);
        if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_NO_MORE_FILES {
                unsafe { CloseHandle(snapshot); }
                return unavailable(format!("Process32NextW-failed:{}", error));
            }
            break;
        }
    }
    unsafe { CloseHandle(snapshot); }

    // Holding every accepted handle also prevents PID reuse between discovery
    // and accounting. Toolhelp parent IDs alone can refer to a dead old parent.
    let process_ids=match owned_descendants(root_pid,&children,opened){Ok(value)=>value,Err(reason)=>return unavailable_with_root(root_pid,reason)};

    let mut total_rss = 0u64;
    let mut total_private = 0u64;
    let mut live_count=0;
    for (_,handle,_) in &process_ids {
        let mut code=0;
        if unsafe{GetExitCodeProcess(handle.0,&mut code)}!=0&&code!=259{continue;}
        let rss = query_rss(handle.0);
        let Some((rss, private)) = rss else {
            if unsafe{GetExitCodeProcess(handle.0,&mut code)}!=0&&code!=259{continue;}
            return unavailable_with_root(root_pid,"GetProcessMemoryInfo-failed".into());
        };
        live_count+=1;
        let Some(next_total) = total_rss.checked_add(rss) else {
            return unavailable("process-tree-rss-overflow");
        };
        total_rss = next_total;
        let Some(next_private) = total_private.checked_add(private) else {
            return unavailable("process-tree-private-overflow");
        };
        total_private = next_private;
    }

    Snapshot {
        rss_bytes: Some(total_rss),
        private_bytes: Some(total_private),
        root_private_bytes: None,
        process_count: Some(live_count),
        available: true,
        source: "windows-process-tree-working-set".to_string(),
        reason: None,
    }
}

#[cfg(test)]
mod tests{
    #[test]
    fn old_parent_pid_links_do_not_claim_unrelated_processes(){
        let children=std::collections::HashMap::from([(10,vec![20,30,50]),(20,vec![40]),(30,vec![60,10])]);
        let births=std::collections::HashMap::from([(10,100),(20,5),(30,110),(40,120),(60,130)]);
        let rows=super::owned_descendants(10,&children,|pid|Ok(births.get(&pid).map(|born|((),*born)))).unwrap();
        assert_eq!(rows.into_iter().map(|row|row.0).collect::<Vec<_>>(),vec![10,30,60]);
        // Unknown access failures remain incomplete, unlike a confirmed exit.
        assert!(super::owned_descendants(10,&children,|pid|if pid==30{Err("unavailable".into())}else{Ok(births.get(&pid).map(|born|((),*born)))}).is_err());
    }
}
