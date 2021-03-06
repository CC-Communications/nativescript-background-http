import { Observable } from "data/observable"
import * as common from "./index"
import * as fileSystemModule from "file-system";
import * as utils from "utils/utils";

const main_queue = dispatch_get_current_queue();

class BackgroundUploadDelegate extends NSObject implements NSURLSessionDelegate, NSURLSessionTaskDelegate, NSURLSessionDataDelegate, NSURLSessionDownloadDelegate {

	static ObjCProtocols = [NSURLSessionDelegate, NSURLSessionTaskDelegate, NSURLSessionDataDelegate, NSURLSessionDownloadDelegate];

	// NSURLSessionDelegate
	URLSessionDidBecomeInvalidWithError(session, error) {
		//console.log("URLSessionDidBecomeInvalidWithError:");
		//console.log(" - session: " + session);
		//console.log(" - error:   " + error);
	}

	URLSessionDidReceiveChallengeCompletionHandler(session, challenge, comlpetionHandler) {
		//console.log("URLSessionDidFinishEventsForBackgroundURLSession: " + session + " " + challenge);
		const disposition = null;
		const credential = null;
		comlpetionHandler(disposition, credential);
	}

	URLSessionDidFinishEventsForBackgroundURLSession(session) {
		//console.log("URLSessionDidFinishEventsForBackgroundURLSession: " + session);
	}

	// NSURLSessionTaskDelegate
	URLSessionTaskDidCompleteWithError(session, nsTask, error) {
		dispatch_async(main_queue, () => {
			const task = Task.getTask(session, nsTask);
			if (task._fileToCleanup) {
				const fileManager = utils.ios.getter(NSFileManager, NSFileManager.defaultManager);
				fileManager.removeItemAtPathError(task._fileToCleanup);
			}
			if (error) {
				task.notifyPropertyChange("status", task.status);
				task.notify({ eventName: "error", object: task, error: error });
			} else {
				task.notifyPropertyChange("upload", task.upload);
				task.notifyPropertyChange("totalUpload", task.totalUpload);
				task.notify({ eventName: "progress", object: task, currentBytes: nsTask.countOfBytesSent, totalBytes: nsTask.countOfBytesExpectedToSend });
				task.notify({ eventName: "complete", object: task });
				Task._tasks.delete(nsTask);
			}
		});
	}

	URLSessionTaskDidReceiveChallengeCompletionHandler(session, task, challenge, completionHandler) {
		//console.log("URLSessionTaskDidReceiveChallengeCompletionHandler: " + session + " " + task + " " + challenge);
		const disposition = null;
		const credential = null;
		completionHandler(disposition, credential);
	}

	URLSessionTaskDidSendBodyDataTotalBytesSentTotalBytesExpectedToSend(nsSession: NSURLSession, nsTask: NSURLSessionTask, data, sent: number, expectedTotal: number) {
		dispatch_async(main_queue, () => {
			const task = Task.getTask(nsSession, nsTask);
			//console.log("notifyPropertyChange: upload");
			task.notifyPropertyChange("upload", task.upload);
			//console.log("notifyPropertyChange: totalUpload");
			task.notifyPropertyChange("totalUpload", task.totalUpload);
			task.notify({ eventName: "progress", object: task, currentBytes: sent, totalBytes: expectedTotal });
		});
	}

	URLSessionTaskNeedNewBodyStream(session, task, need) {
		//console.log("URLSessionTaskNeedNewBodyStream");
	}

	URLSessionTaskWillPerformHTTPRedirectionNewRequestCompletionHandler(session, task, redirect, request, completionHandler) {
		//console.log("URLSessionTaskWillPerformHTTPRedirectionNewRequestCompletionHandler");
		completionHandler(request);
	}

	// NSURLSessionDataDelegate
	URLSessionDataTaskDidReceiveResponseCompletionHandler(session, dataTask, response, completionHandler) {
		//console.log("URLSessionDataTaskDidReceiveResponseCompletionHandler");
		const disposition = null;
		completionHandler(disposition);
	}

	URLSessionDataTaskDidBecomeDownloadTask(session, dataTask, downloadTask) {
		//console.log("URLSessionDataTaskDidBecomeDownloadTask");
	}

	URLSessionDataTaskDidReceiveData(session, dataTask, data) {
		dispatch_async(main_queue, () => {
			//console.log("URLSessionDataTaskDidReceiveData");
			// we have a response in the data...
			const jsTask = Task.getTask(session, dataTask);
			const jsonString = NSString.alloc().initWithDataEncoding(data, NSUTF8StringEncoding);

			jsTask.notify({ eventName: "responded", object: jsTask, data: jsonString.toString() });
		});
	}

	URLSessionDataTaskWillCacheResponseCompletionHandler() {
		//console.log("URLSessionDataTaskWillCacheResponseCompletionHandler");
	}

	// NSURLSessionDownloadDelegate
	URLSessionDownloadTaskDidResumeAtOffsetExpectedTotalBytes(session, task, offset, expects) {
		//console.log("URLSessionDownloadTaskDidResumeAtOffsetExpectedTotalBytes");
	}

	URLSessionDownloadTaskDidWriteDataTotalBytesWrittenTotalBytesExpectedToWrite(session, task, data, written, expected) {
		//console.log("URLSessionDownloadTaskDidWriteDataTotalBytesWrittenTotalBytesExpectedToWrite");
	}

	URLSessionDownloadTaskDidFinishDownloadingToURL(session, task, url) {
		//console.log("URLSessionDownloadTaskDidFinishDownloadingToURL");
	}
}

class Session implements common.Session {
	// TODO: Create a mechanism to clean sessions from the cache that have all their tasks completed, canceled or errored out.
	private static _sessions: { [id: string]: Session } = {};

	private _session: NSURLSession;

	constructor(id: string) {
		const delegate = BackgroundUploadDelegate.alloc().init();
		const configuration = NSURLSessionConfiguration.backgroundSessionConfigurationWithIdentifier(id);
		this._session = NSURLSession.sessionWithConfigurationDelegateDelegateQueue(configuration, delegate, null);
	}

	get ios(): any {
		return this._session;
	}

	
	public uploadFile(fileUri: string, options: common.Request): common.Task {
		if (!fileUri) {
			throw new Error("File must be provided.");
		}

		const url = NSURL.URLWithString(options.url);
		const request = NSMutableURLRequest.requestWithURL(url);

		const headers = options.headers;
		if (headers) {
			for (let header in headers) {
				const value = headers[header];
				if (value !== null && value !== void 0) {
					request.setValueForHTTPHeaderField(value.toString(), header);
				}
			}
		}

		if (options.method) {
			request.HTTPMethod = options.method;
		}

		let fileURL: NSURL;
		if (fileUri.substr(0, 7) === "file://") {
			// File URI in string format
			fileURL = NSURL.URLWithString(fileUri);
		} else if (fileUri.charAt(0) === "/") {
			// Absolute path with leading slash
			fileURL = NSURL.fileURLWithPath(fileUri);
		}

		const newTask = this._session.uploadTaskWithRequestFromFile(request, fileURL);
		newTask.taskDescription = options.description;
		newTask.resume();
		const retTask: common.Task = <any>Task.getTask(this._session, newTask);
		return retTask;
	}
	public multipartUpload(params: any[], options: any): common.Task {
		const MPF = new MultiMultiPartForm();
		for (let i = 0; i < params.length; i++) {
			const curParam = params[i];
			if (typeof curParam.name === 'undefined') {
				throw new Error("You must have a `name` value");
			}

			if (curParam.filename) {
				const destFileName = curParam.destFilename || curParam.filename.substring(curParam.filename.lastIndexOf('/') + 1, curParam.filename.length);
				MPF.appendParam(curParam.name, null, curParam.filename, curParam.mimeType, destFileName);
			} else {
				MPF.appendParam(curParam.name, curParam.value);
			}
		}
		const header = MPF.getHeader();
		const uploadFile = MPF.generateFile();

		if (!options.headers) {
			options.headers = {};
		}
		options.headers['Content-Type'] = header['Content-Type'];

		const task = this.uploadFile(uploadFile, options);

		// Tag the file to be deleted and cleanup after upload
		(<any>task)._fileToCleanup = uploadFile;
		return task;
	}
	static getSession(id: string): common.Session {
		let jsSession = Session._sessions[id];
		if (jsSession) {
			return jsSession;
		}
		jsSession = new Session(id);
		Session._sessions[id] = jsSession;
		return jsSession;
	}
}

class Task extends Observable {
	public static _tasks = new Map<NSURLSessionTask, Task>();

	public _fileToCleanup: string;
	private _task: NSURLSessionTask;
	private _session: NSURLSession;

	constructor(nsSession: NSURLSession, nsTask: NSURLSessionTask) {
		super();
		this._task = nsTask;
		this._session = nsSession;
	}

	get ios(): any {
		return this._task;
	}

	get description(): string {
		return this._task.taskDescription;
	}

	get upload(): number {
		return this._task.countOfBytesSent;
	}

	get totalUpload(): number {
		return this._task.countOfBytesExpectedToSend;
	}

	get status(): string {
		if (this._task.error) {
			return "error";
		}
		switch (this._task.state) {
			case NSURLSessionTaskState.Running: return "uploading";
			case NSURLSessionTaskState.Completed: return "complete";
			case NSURLSessionTaskState.Canceling: return "error";
			case NSURLSessionTaskState.Suspended: return "pending";
		}
	}

	public static getTask(nsSession: NSURLSession, nsTask: NSURLSessionTask): Task {
		let task = Task._tasks.get(nsTask);
		if (task) {
			return task;
		}

		task = new Task(nsSession, nsTask);
		Task._tasks.set(nsTask, task);

		return task;
	}
	public cancel(): void {
		this._task.cancel();
	}
}
export function session(id: string): common.Session {
	return Session.getSession(id);
}



class MultiMultiPartForm {
	private boundary: string;
	private header: any;
	private fileCount: number;
	private fields: Array<any>;

	constructor() {
		this.clear();
	}

	public clear(): void {
		this.boundary = "--------------formboundary" + Math.floor(Math.random() * 100000000000);
		this.header = { "Content-Type": 'multipart/form-data; boundary=' + this.boundary };
		this.fileCount = 0;
		this.fields = [];
	}

	public appendParam(name: string, value: string, filename?: string, mimeType?: string, destFileName?: string): void {
		// If all we are doing is passing a field, we just add it to the fields list
		if (filename == null) {
			this.fields.push({ name: name, value: value });
			return;
		}
		// Load file
		mimeType = mimeType || "application/data";

		if (filename.startsWith("~/")) {
			filename = filename.replace("~/", fileSystemModule.knownFolders.currentApp().path + "/");
		}

		const finalName = destFileName || filename.substr(filename.lastIndexOf('/') + 1, filename.length);
		this.fields.push({ name: name, filename: filename, destFilename: finalName, mimeType: mimeType });
	};

	public generateFile(): string {
		const CRLF = "\r\n";

		const fileName = fileSystemModule.knownFolders.documents().path + "/temp-MPF-" + Math.floor(Math.random() * 100000000000) + ".tmp";

		const combinedData = NSMutableData.alloc().init();

		let results: string = "";
		let tempString: NSString;
		let newData: any;
		for (let i = 0; i < this.fields.length; i++) {
			results += "--" + this.boundary + CRLF;
			results += 'Content-Disposition: form-data; name="' + this.fields[i].name + '"';
			if (!this.fields[i].filename) {
				results += CRLF + CRLF + this.fields[i].value + CRLF;
			} else {
				results += '; filename="' + this.fields[i].destFilename + '"';
				if (this.fields[i].mimeType) {
					results += CRLF + "Content-Type: " + this.fields[i].mimeType;
				}
				results += CRLF + CRLF;
			}

			tempString = NSString.stringWithString(results);
			results = "";
			newData = tempString.dataUsingEncoding(NSUTF8StringEncoding);
			combinedData.appendData(newData);


			if (this.fields[i].filename) {
				const fileData = NSData.alloc().initWithContentsOfFile(this.fields[i].filename);
				combinedData.appendData(fileData);
				results = CRLF;
			}

		}
		// Add final part of it...
		results += "--" + this.boundary + "--" + CRLF;
		tempString = NSString.stringWithString(results);
		newData = tempString.dataUsingEncoding(NSUTF8StringEncoding);
		combinedData.appendData(newData);


		const fileManager = utils.ios.getter(NSFileManager, NSFileManager.defaultManager);
		fileManager.createFileAtPathContentsAttributes(fileName, combinedData, null);

		return fileName;
	};

	public getHeader(): string {
		return this.header;
	};


}