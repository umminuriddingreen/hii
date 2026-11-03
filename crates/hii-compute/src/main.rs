// SPDX-License-Identifier: Apache-2.0
use clap::Parser;

#[derive(Parser)]
#[command(about = "HII open-source native GPU compute", version)]
struct Cli {
    #[command(subcommand)]
    action: hii_compute::ComputeCommand,
}

fn main() {
    if let Err(error) = hii_compute::run(Cli::parse().action) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
