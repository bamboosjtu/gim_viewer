//! Call-scoped native validation timing instrumentation.


// Per-validation, per-thread aggregate only. Nested spans overlap; do not sum.
thread_local! { static VALIDATION_TIMINGS: std::cell::RefCell<Option<std::collections::BTreeMap<&'static str,(u64,f64)>>> = const { std::cell::RefCell::new(None) }; }

pub(super) struct ValidationSpan { label: &'static str, start: std::time::Instant }

impl ValidationSpan { pub(super) fn new(label: &'static str) -> Self { Self { label, start:std::time::Instant::now() } } }

impl Drop for ValidationSpan { fn drop(&mut self) { VALIDATION_TIMINGS.with(|cell| { if let Some(map)=cell.borrow_mut().as_mut() { let v=map.entry(self.label).or_default(); v.0+=1;v.1+=self.start.elapsed().as_secs_f64()*1000.0; } }); } }

pub(super) struct ValidationProfile;

impl ValidationProfile { pub(super) fn begin() -> Self { VALIDATION_TIMINGS.with(|c| *c.borrow_mut()=Some(Default::default())); Self } }

impl Drop for ValidationProfile { fn drop(&mut self) { VALIDATION_TIMINGS.with(|c| { if let Some(map)=c.borrow_mut().take() { eprintln!("[gim-cache-validation] {}",serde_json::to_string(&map).unwrap_or_default()); } }); } }
