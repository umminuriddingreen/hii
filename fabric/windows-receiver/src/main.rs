#[cfg(windows)]
fn main() {
    use hii_windows_receiver::{
        windows::D3d11Renderer, Receiver, UnsupportedInputSink, UnsupportedServiceBridge,
    };

    let mut receiver = Receiver::new(
        D3d11Renderer::new(),
        UnsupportedInputSink,
        UnsupportedServiceBridge,
    );
    match receiver.start().and_then(|()| receiver.health()) {
        Ok(health) => println!("{health:#?}"),
        Err(error) => {
            eprintln!("receiver failed to initialize: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("hii-windows-receiver is unsupported on this platform; build and run it on Windows");
    std::process::exit(2);
}
