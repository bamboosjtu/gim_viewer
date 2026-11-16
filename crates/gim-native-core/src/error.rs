use crate::{NativeError, NativeErrorCode, NativeErrorContext};

impl NativeError {
    pub fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {code, message: message.into(), context: None}
    }
    pub fn operation(mut self, name: impl Into<String>) -> Self {
        let context = self.context.get_or_insert_with(|| NativeErrorContext {operation:None,project_id:None,entry_path:None});
        if context.operation.is_none() {context.operation=Some(name.into());}
        self
    }
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {self.message.fmt(formatter)}
}
impl std::error::Error for NativeError {}
// Internal String helpers are unclassified. Their text never determines a code.
impl From<String> for NativeError {
    fn from(message: String) -> Self {Self::new(NativeErrorCode::OperationFailed,message)}
}
impl From<&str> for NativeError {
    fn from(message: &str) -> Self {Self::new(NativeErrorCode::OperationFailed,message)}
}
impl From<std::io::Error> for NativeError {
    fn from(error: std::io::Error) -> Self {Self::new(NativeErrorCode::Io,error.to_string())}
}
