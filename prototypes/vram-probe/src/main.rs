//! VRAM probe for Local Zero.
//!
//! Enumerates DXGI adapters on Windows and reports total + free VRAM per adapter,
//! then prints the model-tier verdict Local Zero would auto-select for that GPU.
//!
//! Run with: `cargo run --release`

use windows::core::*;
use windows::Win32::Graphics::Dxgi::*;

fn vendor_name(id: u32) -> &'static str {
    match id {
        0x10DE => "NVIDIA",
        0x1002 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft (WARP / software)",
        _ => "Unknown",
    }
}

fn local_zero_verdict(total_mb: u64) -> &'static str {
    let total_gb = total_mb / 1024;
    if total_gb >= 12 {
        "default to Qwen3-14B-GGUF (Q4_0, ~8.5 GB) — comfortable, thinking disabled at runtime"
    } else if total_gb >= 6 {
        "default to Qwen3-4B-Instruct-2507-GGUF (Q4_K_M, ~2.5 GB) — fits with headroom"
    } else if total_gb >= 3 {
        "default to Qwen3-0.6B-GGUF (already in registry) — small but workable"
    } else {
        "no usable dGPU — fall back to CPU inference (slow)"
    }
}

fn main() -> Result<()> {
    println!("Local Zero — VRAM probe (DXGI)\n");
    println!("OS: Windows | Method: IDXGIFactory6 + IDXGIAdapter4::QueryVideoMemoryInfo\n");
    println!("{}", "=".repeat(72));

    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory1()?;
        let mut idx: u32 = 0;
        let mut found_any = false;

        loop {
            let adapter1: IDXGIAdapter1 = match factory.EnumAdapters1(idx) {
                Ok(a) => a,
                Err(_) => break,
            };

            let adapter4: IDXGIAdapter4 = adapter1.cast()?;

            let desc: DXGI_ADAPTER_DESC3 = adapter4.GetDesc3()?;

            let name_chars: Vec<u16> = desc
                .Description
                .iter()
                .take_while(|&&c| c != 0)
                .copied()
                .collect();
            let name = String::from_utf16_lossy(&name_chars);

            let is_software = (desc.Flags.0 & DXGI_ADAPTER_FLAG3_SOFTWARE.0) != 0;

            println!("\nAdapter {} — {}", idx, name.trim());
            println!("  Vendor:    {} (0x{:04X})", vendor_name(desc.VendorId), desc.VendorId);
            println!("  Device ID: 0x{:04X}", desc.DeviceId);
            println!("  Software:  {}", is_software);

            if !is_software {
                let dedicated_mb = (desc.DedicatedVideoMemory as u64) / (1024 * 1024);
                let shared_mb = (desc.SharedSystemMemory as u64) / (1024 * 1024);

                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                adapter4.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)?;

                let budget_mb = info.Budget / (1024 * 1024);
                let usage_mb = info.CurrentUsage / (1024 * 1024);
                let free_mb = budget_mb.saturating_sub(usage_mb);

                println!(
                    "  Dedicated VRAM (total):  {} MB  ({:.1} GiB)",
                    dedicated_mb,
                    dedicated_mb as f64 / 1024.0
                );
                println!("  Shared system RAM:       {} MB", shared_mb);
                println!("  Budget (this process):   {} MB", budget_mb);
                println!("  Currently in use:        {} MB", usage_mb);
                println!(
                    "  Free (approx):           {} MB  ({:.1} GiB)",
                    free_mb,
                    free_mb as f64 / 1024.0
                );

                println!("\n  Local Zero verdict:");
                println!("    → {}", local_zero_verdict(dedicated_mb));
            }

            found_any = true;
            idx += 1;
        }

        println!("\n{}", "=".repeat(72));

        if !found_any {
            println!("\nNo DXGI adapters enumerated. This should never happen on Windows.");
            return Err(Error::from_win32());
        }

        println!("\n{} adapter(s) found.\n", idx);
    }

    Ok(())
}
