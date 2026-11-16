//! Sample-free AST contracts for every command actually exposed by each Tauri registry.
use std::collections::{BTreeMap, BTreeSet};
use syn::{parse::Parser, punctuated::Punctuated, visit::{self, Visit}, Expr, ItemFn, Token};

const DESKTOP: &[(&str, &str)] = &[
    ("lib.rs", include_str!("lib.rs")),
    ("benchmark.rs", include_str!("benchmark.rs")),
    ("tree_export.rs", include_str!("tree_export.rs")),
    ("gim_extract_command.rs", include_str!("gim_extract_command.rs")),
    ("substation_extraction_job.rs", include_str!("substation_extraction_job.rs")),
    ("substation_parse_copy.rs", include_str!("substation_parse_copy.rs")),
    ("db/projects.rs", include_str!("db/projects.rs")),
    ("db/cache_transport.rs", include_str!("db/cache_transport.rs")),
    ("db/cache_validation.rs", include_str!("db/cache_validation.rs")),
    ("db/diagnostics.rs", include_str!("db/diagnostics.rs")),
    ("db/geometry_cache.rs", include_str!("db/geometry_cache.rs")),
    ("db/line_index.rs", include_str!("db/line_index.rs")),
    ("db/project_cache.rs", include_str!("db/project_cache.rs")),
    ("db/semantic_pack.rs", include_str!("db/semantic_pack.rs")),
    ("db/substation_index.rs", include_str!("db/substation_index.rs")),
];
fn path_name(path: &syn::Path) -> String {
    path.segments.iter().map(|part| part.ident.to_string()).collect::<Vec<_>>().join("::")
}
#[derive(Default)]
struct Registry {
    commands: BTreeMap<String, ItemFn>,
    registered: BTreeSet<String>,
}
impl<'ast> Visit<'ast> for Registry {
    fn visit_item_fn(&mut self, function: &'ast ItemFn) {
        if function.attrs.iter().any(|attr| path_name(attr.path()) == "tauri::command") {
            let name = function.sig.ident.to_string();
            assert!(self.commands.insert(name.clone(), function.clone()).is_none(), "duplicate command: {name}");
        }
        visit::visit_item_fn(self, function);
    }
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        if path_name(&node.path) == "tauri::generate_handler" {
            let paths = Punctuated::<syn::Path, Token![,]>::parse_terminated.parse2(node.tokens.clone()).unwrap();
            for path in paths {
                let name = path.segments.last().unwrap().ident.to_string();
                assert!(self.registered.insert(name.clone()), "duplicate registration: {name}");
            }
        }
    }
}

struct ThreadBoundary<'a> {
    command: &'a str,
    depth: usize,
    boundaries: usize,
    errors: Vec<String>,
}
impl<'ast> Visit<'ast> for ThreadBoundary<'_> {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        let name = match node.func.as_ref() { Expr::Path(path) => path_name(&path.path), _ => String::new() };
        if name == "tauri::async_runtime::spawn_blocking" || name == "crate::native_command::blocking" {
            self.boundaries += 1;
            for arg in &node.args {
                if let Expr::Closure(closure) = arg {
                    if closure.asyncness.is_some() { self.errors.push("blocking work cannot return an unevaluated async closure".into()); }
                    self.depth += 1;
                    self.visit_expr(&closure.body);
                    self.depth -= 1;
                } else { self.visit_expr(arg); }
            }
            return;
        }
        let pure = matches!(name.as_str(), "Ok" | "Err" | "drop" | "tauri::ipc::Response::new" | "ImportLease" | "Instant::now" | "NativeError::new");
        let binary_handoff = name == "decode_binary_cache_write_request" && matches!(self.command,
            "write_cache_file_binary" | "write_glb_file_binary" | "write_device_lod_artifact");
        let envelope_value = self.command == "decode_binary_cache_write_request"
            && matches!(name.as_str(), "u32::from_le_bytes" | "serde_json::from_slice");
        let start_control = (name == "reserve_start" && self.command == "start_substation_extraction")
            || (name == "reserve_line_begin" && self.command == "save_line_graph_begin");
        let cancellation = matches!(name.as_str(), "cancel_job" | "registry") && matches!(self.command, "cancel_substation_extraction" | "cancel_all");
        if self.depth == 0 && !pure && !binary_handoff && !envelope_value && !start_control && !cancellation {
            self.errors.push(format!("call {name} executes outside spawn_blocking"));
        }
        visit::visit_expr_call(self, node);
    }
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        // No DB/job lifecycle mutex, filesystem call, hash or unknown helper may execute here.
        // Clone/inner hand owned Store data to mobile workers; swap/store preserve import control ordering.
        let method=node.method.to_string();
        let control_method = match self.command {
            "cancel_job" => matches!(method.as_str(), "lock" | "remove" | "ok_or" | "ok_or_else" | "store"),
            "reserve_start" | "has_running_job" | "reserve_line_begin" => matches!(method.as_str(), "load" | "fetch_add"),
            "registry" => method == "get_or_init",
            "cancel_all" => matches!(method.as_str(), "store" | "lock" | "values"),
            "prepare_project" | "cancel_import" => matches!(method.as_str(), "swap" | "store"),
            "decode_binary_cache_write_request" => matches!(method.as_str(),
                "body" | "as_slice" | "len" | "checked_add" | "ok_or_else" | "trim" | "is_empty" | "to_vec"),
            _ => false,
        };
        if self.depth == 0 && !control_method && !matches!(method.as_str(), "clone" | "inner" | "map_err" | "to_string" | "into") {
            self.errors.push(format!("method {} executes outside spawn_blocking", node.method));
        }
        visit::visit_expr_method_call(self, node);
    }
    fn visit_expr_async(&mut self, node: &'ast syn::ExprAsync) {
        let previous = self.depth;
        self.depth = 0; // Creating a future in a blocking closure does not execute its body there.
        visit::visit_expr_async(self, node);
        self.depth = previous;
    }
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        if self.depth > 0 { return; }
        if path_name(&node.path) == "format" {
            match Punctuated::<Expr, Token![,]>::parse_terminated.parse2(node.tokens.clone()) {
                Ok(args) => for arg in &args { self.visit_expr(arg); },
                Err(error) => self.errors.push(format!("uninspectable format arguments: {error}")),
            }
        } else { self.errors.push(format!("macro {} outside blocking boundary", path_name(&node.path))); }
    }
}
fn check(function: &ItemFn) -> Vec<String> {
    let name = function.sig.ident.to_string();
    let control = matches!(name.as_str(), "cancel_substation_extraction" | "cancel_import");
    let mut visitor = ThreadBoundary {command: &name, depth: 0, boundaries: 0, errors: Vec::new()};
    if !control && function.sig.asyncness.is_none() { visitor.errors.push("registered work command must be async".into()); }
    visitor.visit_block(&function.block);
    if !control && visitor.boundaries == 0 { visitor.errors.push("registered work command requires spawn_blocking".into()); }
    visitor.errors
}
fn check_registry(sources: &[(&str, &str)]) {
    let mut registry = Registry::default();
    for (name, source) in sources {
        let tree = syn::parse_file(source).unwrap_or_else(|error| panic!("{name}: {error}"));
        registry.visit_file(&tree);
    }
    assert!(!registry.registered.is_empty());
    let declared: BTreeSet<_> = registry.commands.keys().cloned().collect();
    assert_eq!(declared, registry.registered, "registered command must resolve to an inspected command declaration");
    let mut failures = Vec::new();
    for name in &registry.registered {
        failures.extend(check(&registry.commands[name]).into_iter().map(|reason| format!("{name}: {reason}")));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    eprintln!("checked {} registered command thread boundaries", registry.registered.len());
}
#[test]
fn desktop_command_registry_thread_boundaries() { check_registry(DESKTOP); }
#[test]
fn registered_command_failures_use_the_generated_error_contract() {
    let mut registry=Registry::default();
    for (_,source) in DESKTOP {registry.visit_file(&syn::parse_file(source).unwrap());}
    registry.visit_file(&syn::parse_file(include_str!("../../../app/src-tauri/src/lib.rs")).unwrap());
    registry.visit_file(&syn::parse_file(include_str!("../../../crates/tauri-plugin-gim-import/src/lib.rs")).unwrap());
    for (name,function) in registry.commands {
        if name=="cancel_import" {continue;}
        let syn::ReturnType::Type(_,ty)=&function.sig.output else {panic!("{name}: error contract missing")};
        let syn::Type::Path(ty)=ty.as_ref() else {panic!("{name}: result type missing")};
        let segment=ty.path.segments.last().unwrap();assert_eq!(segment.ident,"Result","{name}");
        let syn::PathArguments::AngleBracketed(args)=&segment.arguments else {panic!("{name}: result arguments missing")};
        let Some(syn::GenericArgument::Type(syn::Type::Path(error)))=args.args.last() else {panic!("{name}: error type missing")};
        assert_eq!(error.path.segments.last().unwrap().ident,"NativeError","{name}: IPC error must be generated NativeError");
    }
}
#[test]
fn fam_dev_dtos_are_imported_from_the_generated_shared_contract() {
    let contract:serde_json::Value=serde_json::from_str(include_str!("../../../contracts/native-v1.json")).unwrap();
    let names:std::collections::BTreeSet<_>=contract["types"].as_object().unwrap().keys().cloned().collect();
    for (file,source) in DESKTOP {
        if !file.starts_with("db/") {continue;}
        for item in syn::parse_file(source).unwrap().items {
            if let syn::Item::Struct(value)=item {assert!(!names.contains(&value.ident.to_string()),"{file} redeclares {}",value.ident);}
        }
    }
}
#[test]
fn mobile_command_registry_thread_boundaries() { check_registry(&[("mobile/lib.rs", include_str!("../../../app/src-tauri/src/lib.rs"))]); }
#[test]
fn cancellation_and_start_control_helpers_remain_memory_only() {
    let tree=syn::parse_file(include_str!("substation_extraction_job.rs")).unwrap();
    for name in ["cancel_job", "reserve_start", "registry", "cancel_all", "has_running_job"] {
        let function=tree.items.iter().find_map(|item|match item {syn::Item::Fn(f) if f.sig.ident==name=>Some(f),_=>None}).unwrap();
        let mut visitor=ThreadBoundary {command:name,depth:0,boundaries:0,errors:Vec::new()};
        visitor.visit_block(&function.block);
        assert!(visitor.errors.is_empty(),"{name}: {:?}",visitor.errors);
    }
    let tree=syn::parse_file(include_str!("db/line_index.rs")).unwrap();
    let function=tree.items.iter().find_map(|item|match item {syn::Item::Fn(f) if f.sig.ident=="reserve_line_begin"=>Some(f),_=>None}).unwrap();
    let mut visitor=ThreadBoundary {command:"reserve_line_begin",depth:0,boundaries:0,errors:Vec::new()};
    visitor.visit_block(&function.block);assert!(visitor.errors.is_empty(),"{:?}",visitor.errors);
}
#[test]
fn binary_request_handoff_remains_value_only() {
    let tree=syn::parse_file(include_str!("db/cache_protocol.rs")).unwrap();
    let function=tree.items.iter().find_map(|item|match item {syn::Item::Fn(f) if f.sig.ident=="decode_binary_cache_write_request"=>Some(f),_=>None}).unwrap();
    let mut visitor=ThreadBoundary {command:"decode_binary_cache_write_request",depth:0,boundaries:0,errors:Vec::new()};
    visitor.visit_block(&function.block);assert!(visitor.errors.is_empty(),"{:?}",visitor.errors);
}
#[test]
fn rejects_sync_async_io_helper_and_macro_bypasses() {
    for source in [
        "fn work() { std::fs::read(\"x\"); }",
        "async fn work() { std::fs::read(\"x\"); }",
        "async fn work() { helper(); tauri::async_runtime::spawn_blocking(move || Ok(())).await; }",
        "async fn work() { tauri::async_runtime::spawn_blocking(move || async { std::fs::read(\"x\"); }).await; }",
        "async fn work() { format!(\"{:?}\", std::fs::read(\"x\")); tauri::async_runtime::spawn_blocking(move || Ok(())).await; }",
        "async fn work() { state.lock(); tauri::async_runtime::spawn_blocking(move || Ok(())).await; }",
    ] {
        assert!(!check(&syn::parse_str::<ItemFn>(source).unwrap()).is_empty(), "checker accepted {source}");
    }
    assert!(check(&syn::parse_str::<ItemFn>("async fn work() { crate::native_command::blocking(\"work\", move || helper()).await }").unwrap()).is_empty());
}
