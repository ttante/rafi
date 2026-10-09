import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Keep this host program separate from all provider/user input. The provider is
// created suspended, assigned to a non-breakaway Job Object, then resumed.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Text;
using System.Threading;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RafiProbeJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref UIntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool okay) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Name(string tag) { return "Global\\RafiProbe-" + Guid.Parse(tag).ToString(); }
  public static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  static uint Active(IntPtr job) { Accounting value; Check(QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return value.Active; }
  public static string Query(string tag) {
    IntPtr job=OpenJobObject(4,false,Name(tag));
    if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return "absent"; return "unknown"; }
    try { return Active(job)==0 ? "empty" : "active"; } finally { CloseHandle(job); }
  }
  static bool OwnerAlive(int pid,long start) {
    try { using(var owner=System.Diagnostics.Process.GetProcessById(pid)) return !owner.HasExited && owner.StartTime.ToUniversalTime().ToFileTimeUtc()==start; } catch { return false; }
  }
  public static int Run(string tag,string executable,string[] args,string cwd,int ownerPid,long ownerStart) {
    IntPtr job=CreateJobObject(IntPtr.Zero,Name(tag));
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new Exception("Job name already exists"); }
    ProcessInfo child=new ProcessInfo(); IntPtr attributes=IntPtr.Zero, jobs=IntPtr.Zero; bool initialized=false;
    try {
      Extended limits=new Extended(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; never allow breakaway.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
      UIntPtr bytes=UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
      Check(bytes.ToUInt64()>0); attributes=Marshal.AllocHGlobal((IntPtr)(long)bytes.ToUInt64());
      Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes)); initialized=true;
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns containment atomically with creation.
      Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x2000du),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      StartupEx startup=new StartupEx(); startup.Basic.Size=Marshal.SizeOf(typeof(StartupEx)); startup.Basic.Flags=0x100; startup.Attributes=attributes;
      startup.Basic.Input=GetStdHandle(-10); startup.Basic.Output=GetStdHandle(-11); startup.Basic.Error=GetStdHandle(-12);
      StringBuilder command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x80004,IntPtr.Zero,cwd,ref startup,out child));
      if(!OwnerAlive(ownerPid,ownerStart)) throw new Exception("Probe owner exited before startup");
      Check(ResumeThread(child.Thread)!=0xffffffff);
      while(true) {
        uint waited=WaitForSingleObject(child.Process,100);
        if(waited==0) break;
        Check(waited==258); // WAIT_TIMEOUT
        if(!OwnerAlive(ownerPid,ownerStart)) { TerminateJobObject(job,125); throw new Exception("Probe owner exited"); }
      }
      uint code; Check(GetExitCodeProcess(child.Process,out code));
      Check(TerminateJobObject(job,0));
      DateTime deadline=DateTime.UtcNow.AddSeconds(5);
      while(Active(job)!=0 && DateTime.UtcNow<deadline) Thread.Sleep(25);
      if(Active(job)!=0) throw new Exception("Job cleanup could not be verified");
      return unchecked((int)code);
    } finally {
      if(initialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread);
      if(child.Process!=IntPtr.Zero) CloseHandle(child.Process);
      CloseHandle(job);
    }
  }
}`;

function encoded(script: string): string[] { return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]; }
const declaration = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_JOB_SOURCE}\n'@;`;

/** Standard npm shims are invoked as Node argv, never interpreted as shell text. */
export function windowsRuntimeInvocation(executable: string, args: string[]): { executable: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(executable)) return { executable, args };
  const shim = readFileSync(executable, "utf8");
  const match = /"%(?:dp0%|~dp0)[\\/]*([^"\r\n]+\.[cm]?js)"/i.exec(shim);
  if (!match) throw new Error("Unsupported Windows runtime shim; install the provider's standard npm shim or native executable");
  const script = join(dirname(executable), match[1]!);
  if (!existsSync(script)) throw new Error("Windows runtime shim target is missing");
  return { executable: process.execPath, args: [script, ...args] };
}

export function windowsProbeCommand(tag: string, executable: string, args: string[], cwd: string, ownerStart: string, gated = false): { executable: string; args: string[]; config: string } {
  if (!/^[a-f0-9-]{36}$/.test(tag)) throw new Error("Invalid Windows job identity");
  if (!/^win:\d+$/.test(ownerStart)) throw new Error("Windows probe owner identity is unavailable");
  const target = windowsRuntimeInvocation(executable, args);
  return {
    executable: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: encoded(`${gated ? "if ([Console]::In.ReadLine() -ne 'rafi-create-job') { exit 125 };" : ""}${declaration}\n$c=ConvertFrom-Json $env:RAFI_WINDOWS_PROBE_CONFIG; Remove-Item Env:RAFI_WINDOWS_PROBE_CONFIG; $code=[RafiProbeJob]::Run([string]$c.tag,[string]$c.executable,[string[]]$c.args,[string]$c.cwd,[int]$c.ownerPid,[long]$c.ownerStart); exit $code`),
    config: JSON.stringify({ tag, ...target, cwd, ownerPid: process.pid, ownerStart: ownerStart.slice(4) }),
  };
}

export function windowsProbeJobState(tag: string, timeoutMs = 10_000): "absent" | "empty" | "active" | "unknown" {
  if (!/^[a-f0-9-]{36}$/.test(tag)) return "unknown";
  try {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, encoded(`${declaration}\n[RafiProbeJob]::Query('${tag}')`), { encoding: "utf8", timeout: Math.max(1, timeoutMs), stdio: ["ignore", "pipe", "ignore"] }).trim();
    return output === "absent" || output === "empty" || output === "active" ? output : "unknown";
  } catch { return "unknown"; }
}
