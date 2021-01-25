/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the MIT License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import fs = require("fs");
import path = require("path");
import * as vscode from "vscode";
import { Uri } from "vscode";

import { BookmarkQuickPickItem, File } from "../vscode-numbered-bookmarks-core/src/api/bookmark";
import { MAX_BOOKMARKS, NO_BOOKMARK_DEFINED } from "../vscode-numbered-bookmarks-core/src/api/constants";
// import { File } from "../vscode-numbered-bookmarks-core/src/model/bookmark";
import { Controller } from "../vscode-numbered-bookmarks-core/src/model/controller";
import { clearBookmarks, listBookmarks } from "../vscode-numbered-bookmarks-core/src/model/operations";
import { revealLineInDocument } from "../vscode-numbered-bookmarks-core/src/reveal";
import { Sticky } from "../vscode-numbered-bookmarks-core/src/sticky/sticky";
import { appendPath, createDirectory, createDirectoryUri, fileExists, readFileUri, uriExists, writeFile, writeFileUri } from "../vscode-numbered-bookmarks-core/src/utils";
import { WhatsNewManager } from "../vscode-whats-new/src/Manager";
import { WhatsNewNumberedBookmarksContentProvider } from "./whats-new/NumberedBookmarksContentProvider";

const STATE_SVG_VERSION = "numberedBookmarksSvgVersion";

const getFillColor = (): string => {
    const config = vscode.workspace
      .getConfiguration("numberedBookmarks")
      .inspect("gutterIconFillColor");
    
    return <string> (config.globalValue ? config.globalValue : config.defaultValue);
  };
  
const getNumberColor = (): string => {
    const config = vscode.workspace
      .getConfiguration("numberedBookmarks")
      .inspect("gutterIconNumberColor");
      
    return <string> (config.globalValue ? config.globalValue : config.defaultValue);
  };

// this method is called when vs code is activated
export async function activate(context: vscode.ExtensionContext) {
    let controller: Controller;
    let activeController: Controller;
    let controllers: Controller[] = [];
    let activeEditorCountLine: number;
    let timeout = null;    
    let activeEditor = vscode.window.activeTextEditor;
    let activeBookmark: File;            
    const bookmarkDecorationType: vscode.TextEditorDecorationType[] = [];
    const provider = new WhatsNewNumberedBookmarksContentProvider();
    const viewer = new WhatsNewManager(context).registerContentProvider("alefragnani", "numbered-bookmarks", provider);
    viewer.showPageInActivation();
    context.subscriptions.push(vscode.commands.registerCommand("numberedBookmarks.whatsNew", () => viewer.showPage()));

    // load pre-saved bookmarks
    let didLoadBookmarks: boolean;
    if (vscode.workspace.workspaceFolders) {
        didLoadBookmarks = await loadWorkspaceState(vscode.workspace.workspaceFolders[0]); // activeEditor.document.uri);
    } else {
        didLoadBookmarks = await loadWorkspaceState(undefined);
    }

    if (vscode.workspace.workspaceFolders) {
        controllers = await Promise.all(
            vscode.workspace.workspaceFolders!.map(async workspaceFolder => {
                const ctrl = loadBookmarks(workspaceFolder);

                return ctrl;
            })
        );
            
        console.log(controllers.length);
    }
    
    updateBookmarkSvg();
    updateBookmarkDecorationType();

    // Connect it to the Editors Events
    if (activeEditor) {
        if (!didLoadBookmarks) {
            controller.addFile(activeEditor.document.uri);
        }
        activeEditorCountLine = activeEditor.document.lineCount;
        activeBookmark = controller.fromUri(activeEditor.document.uri);
        triggerUpdateDecorations();
    }

    // new docs
    vscode.workspace.onDidOpenTextDocument(doc => {
        // activeEditorCountLine = doc.lineCount;
        controller.addFile(doc.uri);
    });

    vscode.window.onDidChangeActiveTextEditor(editor => {
        activeEditor = editor;
        if (editor) {
            activeEditorCountLine = editor.document.lineCount;
            activeBookmark = controller.fromUri(editor.document.uri);
            
            // activeController = controllers.find(ctrl => 
            //        ctrl.workspaceFolder.uri.path === vscode.workspace.getWorkspaceFolder(editor.document.uri).uri.path)

            triggerUpdateDecorations();
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (activeEditor && event.document === activeEditor.document) {
            let updatedBookmark: boolean = true;
            // call sticky function when the activeEditor is changed
            if (activeBookmark && activeBookmark.bookmarks.length > 0) {
                // updatedBookmark = stickyBookmarks(event);
                updatedBookmark = Sticky.stickyBookmarks(event, activeEditorCountLine, 
                    activeBookmark, activeEditor);
            }

            activeEditorCountLine = event.document.lineCount;
            updateDecorations();

            if (updatedBookmark) {
                saveWorkspaceState();
            }
        }
    }, null, context.subscriptions);
    
    vscode.workspace.onDidChangeConfiguration(event => {    
        if (event.affectsConfiguration("numberedBookmarks.gutterIconFillColor") 
            || event.affectsConfiguration("numberedBookmarks.gutterIconNumberColor")    
        ) {
            context.globalState.update(
                STATE_SVG_VERSION, 
                getCurrentSvgVersion() + 1
            );
            updateBookmarkSvg();  
            updateBookmarkDecorationType();      
        }
        if (event.affectsConfiguration("numberedBookmarks.backgroundLineColor")) {
            for (const dec of bookmarkDecorationType) {
                dec.dispose();
            }
            
            updateBookmarkDecorationType();
            updateDecorations();
            
            for (const dec of bookmarkDecorationType) {
                context.subscriptions.push(dec);
            }
        }
    }, null, context.subscriptions);
    
    // The only way to update the decorations after changing the color is to create a new file
    function updateBookmarkSvg() {  
        const v = getCurrentSvgVersion();
        
        if (fs.existsSync(context.asAbsolutePath(`images/bookmark1-${v}.svg`))) {
            return;
        }
        
        const gutterIconFillColor = getFillColor();
        const gutterIconNumberColor = getNumberColor();
        const content = fs.readFileSync(context.asAbsolutePath("images/bookmark.svg"), "utf8");
        
        for (let i = 0; i <= 9; i++) {
            const svgContent = content
                .replace("{{gutterIconFillColor}}", gutterIconFillColor)
                .replace("{{gutterIconNumberColor}}", gutterIconNumberColor)
                .replace("{{number}}", i.toString());
                
            try {    
                fs.writeFileSync(context.asAbsolutePath(`images/bookmark${i}-${v}.svg`), svgContent, {encoding: "utf8"}); 
            } catch (err) {
                vscode.window.showErrorMessage(`Can't write to ${err.path}`);            
            }
            
            const bookmarkPath = context.asAbsolutePath(`images/bookmark${i}-${v - 1}.svg`);        
            if (fs.existsSync(bookmarkPath)) {
                fs.unlinkSync(bookmarkPath);
            }
        }   

        triggerUpdateDecorations(); 
    }
    
    // Need to udpate every time the color is changed
    function updateBookmarkDecorationType() {
        const backgroundLineColor: string = vscode.workspace.getConfiguration("numberedBookmarks").get("backgroundLineColor", "");
        const v = getCurrentSvgVersion();
        
        for (let index = 0; index < MAX_BOOKMARKS; index++) {
            if (undefined !== bookmarkDecorationType[ index ]) {
                bookmarkDecorationType[ index ].dispose();
            }
            const gutterIconPath: string = context.asAbsolutePath(`images/bookmark${index}-${v}.svg`);   
            bookmarkDecorationType[ index ] = vscode.window.createTextEditorDecorationType({
                gutterIconPath,
                overviewRulerLane: vscode.OverviewRulerLane.Right,
                overviewRulerColor: getFillColor(),
                backgroundColor: backgroundLineColor ? backgroundLineColor : undefined,
                isWholeLine: backgroundLineColor ? true : false
            });
        }
    }
    
    function getCurrentSvgVersion(): number {
        return parseInt(context.globalState.get(STATE_SVG_VERSION, "0"), 10);
    }

    // Timeout
    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(updateDecorations, 100);
    }

    function getDecoration(n: number): vscode.TextEditorDecorationType {
        return bookmarkDecorationType[ n ];
    }

    // Evaluate (prepare the list) and DRAW
    function updateDecorations() {
        if (!activeEditor) {
            return;
        }

        if (!activeBookmark) {
            return;
        }

        let books: vscode.Range[] = [];
        // Remove all bookmarks if active file is empty
        if (activeEditor.document.lineCount === 1 && activeEditor.document.lineAt(0).text === "") {
            activeBookmark.bookmarks = [];
        } else {
            const invalids = [];
            for (let index = 0; index < MAX_BOOKMARKS; index++) {
                books = [];
                if (activeBookmark.bookmarks[ index ] < 0) {
                    activeEditor.setDecorations(getDecoration(index), books);
                } else {
                    const element = activeBookmark.bookmarks[ index ];
                    if (element < activeEditor.document.lineCount) {
                        const decoration = new vscode.Range(element, 0, element, 0);
                        books.push(decoration);
                        activeEditor.setDecorations(getDecoration(index), books);
                    } else {
                        invalids.push(index);
                    }
                }
            }

            if (invalids.length > 0) {
                // tslint:disable-next-line:prefer-for-of
                for (let indexI = 0; indexI < invalids.length; indexI++) {
                    activeBookmark.bookmarks[ invalids[ indexI ] ] = NO_BOOKMARK_DEFINED;
                }
            }
        }
    }
    
    // other commands
    for (let i = 0; i <= 9; i++) {
        vscode.commands.registerCommand(
            `numberedBookmarks.toggleBookmark${i}`, 
            () => toggleBookmark(i, vscode.window.activeTextEditor.selection.active.line)
        );
        vscode.commands.registerCommand(
            `numberedBookmarks.jumpToBookmark${i}`,
            () => jumpToBookmark(i)
        );
    }

    vscode.commands.registerCommand("numberedBookmarks.clear", () => {
        clearBookmarks(activeBookmark);
        
        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("numberedBookmarks.clearFromAllFiles", () => {
        for (const file of controller.files) {
            clearBookmarks(file);
        }

        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("numberedBookmarks.list", () => {
        // no bookmark
        if (activeBookmark.bookmarks.length === 0) {
            vscode.window.showInformationMessage("No Bookmark found");
            return;
        }

        // push the items
        const items: vscode.QuickPickItem[] = [];
        // for (let index = 0; index < activeBookmark.bookmarks.length; index++) {
        //     let element = activeBookmark.bookmarks[ index ];
        for (let element of activeBookmark.bookmarks) {
            // > -> temporary fix for modified files
            if ((element !== -1) && (element <= vscode.window.activeTextEditor.document.lineCount)) {
                const lineText = vscode.window.activeTextEditor.document.lineAt(element).text;
                element++;
                items.push({ label: element.toString(), description: lineText });
            }
        }

        // pick one
        const currentLine: number = vscode.window.activeTextEditor.selection.active.line + 1;
        const options = <vscode.QuickPickOptions> {
            placeHolder: "Type a line number or a piece of code to navigate to",
            matchOnDescription: true,
            matchOnDetail: true,
            onDidSelectItem: item => {
                const itemT = <vscode.QuickPickItem> item;
                revealLine(parseInt(itemT.label, 10) - 1);
            }
        };

        vscode.window.showQuickPick(items, options).then(selection => {
            if (typeof selection === "undefined") {
                revealLine(currentLine - 1);
                return;
            }
            revealLine(parseInt(selection.label, 10) - 1);
        });
    });

    vscode.commands.registerCommand("numberedBookmarks.listFromAllFiles", () => {

        // no bookmark
        let totalBookmarkCount: number = 0;
        // tslint:disable-next-line:prefer-for-of
        for (let index = 0; index < controller.files.length; index++) {
            totalBookmarkCount = totalBookmarkCount + controller.files[ index ].bookmarks.length;
        }
        if (totalBookmarkCount === 0) {
            vscode.window.showInformationMessage("No Bookmarks found");
            return;
        }

        // push the items
        const items: BookmarkQuickPickItem[] = [];
        // const activeTextEditorPath = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : "";
        const activeTextEditor = vscode.window.activeTextEditor;
        const promisses = [];
        const currentLine: number = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.selection.active.line + 1 : -1;

        let currentWorkspaceFolder: vscode.WorkspaceFolder; 
        if (activeTextEditor) {
            currentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeTextEditor.document.uri);
        }            
        
        // tslint:disable-next-line:prefer-for-of
        for (let index = 0; index < controller.files.length; index++) {
            const file = controller.files[ index ];

            const pp = listBookmarks(file, controller.workspaceFolder);
            // const pp = bookmark.listBookmarks();
            promisses.push(pp);
        }

        Promise.all(promisses).then(
            (values) => {
                // tslint:disable-next-line:prefer-for-of
                for (let index = 0; index < values.length; index++) {
                    const element = values[ index ];
                    // tslint:disable-next-line:prefer-for-of
                    for (let indexInside = 0; indexInside < element.length; indexInside++) {
                        const elementInside = element[ indexInside ];

                        if (elementInside.detail.toString().toLowerCase() === activeTextEditor.document.uri.fsPath.toLowerCase()) {
                            items.push(
                                {
                                    label: elementInside.label,
                                    description: elementInside.description,
                                    uri: elementInside.uri
                                }
                            );
                        } else {
                            const itemPath = removeBasePathFrom(elementInside.detail, currentWorkspaceFolder);
                            items.push(
                                {
                                    label: elementInside.label,
                                    description: elementInside.description,
                                    detail: itemPath,
                                    uri: elementInside.uri
                                }
                            );
                        }
                    }

                }

                // sort
                // - active document
                // - no octicon - document inside project
                // - with octicon - document outside project
                let itemsSorted: vscode.QuickPickItem[];
                itemsSorted = items.sort(function(a: vscode.QuickPickItem, b: vscode.QuickPickItem): number {
                    if (!a.detail && !b.detail) {
                        return 0;
                    }

                    if (!a.detail && b.detail) {
                        return -1;
                    }
                    
                    if (a.detail && !b.detail) {
                            return 1;
                    }

                    if ((a.detail.toString().indexOf("$(file-submodule) ") === 0) && (b.detail.toString().indexOf("$(file-directory) ") === 0)) {
                        return -1;
                    };
                    
                    if ((a.detail.toString().indexOf("$(file-directory) ") === 0) && (b.detail.toString().indexOf("$(file-submodule) ") === 0)) {
                        return 1;
                    };

                    if ((a.detail.toString().indexOf("$(file-submodule) ") === 0) && (b.detail.toString().indexOf("$(file-submodule) ") === -1)) {
                        return 1;
                    };
                    
                    if ((a.detail.toString().indexOf("$(file-submodule) ") === -1) && (b.detail.toString().indexOf("$(file-submodule) ") === 0)) {
                        return -1;
                    };
                    
                    if ((a.detail.toString().indexOf("$(file-directory) ") === 0) && (b.detail.toString().indexOf("$(file-directory) ") === -1)) {
                        return 1;
                    }
                    
                    if ((a.detail.toString().indexOf("$(file-directory) ") === -1) && (b.detail.toString().indexOf("$(file-directory) ") === 0)) {
                        return -1;
                    }
                    
                    return 0;
                });

                const options = <vscode.QuickPickOptions> {
                    placeHolder: "Type a line number or a piece of code to navigate to",
                    matchOnDescription: true,
                    onDidSelectItem: item => {

                        const itemT = <BookmarkQuickPickItem> item

                        let fileUri: Uri;
                        if (!itemT.detail) {
                            fileUri = activeTextEditor.document.uri;
                        } else {
                            fileUri = itemT.uri;
                        }
                        // let filePath: string;
                        // // no detail - previously active document
                        // if (!itemT.detail) {
                        //     filePath = activeTextEditorPath;
                        // } else {
                        //     // with octicon - document outside project
                        //     if (itemT.detail.toString().indexOf("$(file-directory) ") === 0) {
                        //         filePath = itemT.detail.toString().split("$(file-directory) ").pop();
                        //     } else { // with octicon - documento from other workspaceFolder
                        //         if (itemT.detail.toString().indexOf("$(file-submodule)") === 0) {
                        //             filePath = itemT.detail.toString().split("$(file-submodule) ").pop();
                        //             for (const wf of vscode.workspace.workspaceFolders) {
                        //                 if (wf.name === filePath.split(path.sep).shift()) {
                        //                     filePath = path.join(wf.uri.fsPath, filePath.split(path.sep).slice(1).join(path.sep));
                        //                     break;
                        //                 }
                        //             }
                                    
                        //         } else { // no octicon - document inside project
                        //             if (currentWorkspaceFolder) {
                        //                 filePath = currentWorkspaceFolder.uri.fsPath + itemT.detail.toString();
                        //             } else {
                        //                 if (vscode.workspace.workspaceFolders) {
                        //                     filePath = vscode.workspace.workspaceFolders[0].uri.fsPath + itemT.detail.toString();
                        //                 } else {
                        //                     filePath = itemT.detail.toString();
                        //                 }
                        //             }
                        //         }
                        //     }
                        // }

                        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase()) {
                            revealLine(parseInt(itemT.label, 10) - 1);
                        } else {
                            // const uriDocument: vscode.Uri = vscode.Uri.file(filePath);
                            // vscode.workspace.openTextDocument(uriDocument).then(doc => {
                            //     // vscode.window.showTextDocument(doc, undefined, true).then(editor => {
                            //     vscode.window.showTextDocument(doc, {preserveFocus: true, preview: true}).then(editor => {
                            //         revealLine(parseInt(itemT.label, 10) - 1);
                            //     });
                            // });
                            revealLineInDocument(parseInt(itemT.label, 10), fileUri, true);
                        }
                    }
                };
                vscode.window.showQuickPick(itemsSorted, options).then(selection => {
                    if (typeof selection === "undefined") {
                        if (!activeTextEditor) {
                            vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                            return;
                        } else {
                            // const uriDocument: vscode.Uri = vscode.Uri.file(activeTextEditorPath);
                            vscode.workspace.openTextDocument(activeTextEditor.document.uri).then(doc => {
                                vscode.window.showTextDocument(doc).then(editor => {
                                    revealLine(currentLine - 1);
                                    return;
                                });
                            });
                        }
                    }

                    if (typeof selection === "undefined") {
                        return;
                    }

                    if (!selection.detail) {
                        revealLine(parseInt(selection.label, 10) - 1);
                    } else {    
                        let newPath: string;
                        // with octicon - document outside project
                        if (selection.detail.toString().indexOf("$(file-directory) ") === 0) {
                            newPath = selection.detail.toString().split("$(file-directory) ").pop();
                        } else {// no octicon - document inside project
                            if (selection.detail.toString().indexOf("$(file-submodule)") === 0) {
                                newPath = selection.detail.toString().split("$(file-submodule) ").pop();
                                for (const wf of vscode.workspace.workspaceFolders) {
                                    if (wf.name === newPath.split(path.sep).shift()) {
                                        newPath = path.join(wf.uri.fsPath, newPath.split(path.sep).slice(1).join(path.sep));
                                        break;
                                    }
                                }                            
                            } else { // no octicon - document inside project
                                if (currentWorkspaceFolder) {
                                    newPath = currentWorkspaceFolder.uri.fsPath + selection.detail.toString();
                                } else {
                                    if (vscode.workspace.workspaceFolders) {
                                        newPath = vscode.workspace.workspaceFolders[0].uri.fsPath + selection.detail.toString();
                                    } else {
                                        newPath = selection.detail.toString();
                                    }
                                }
                            }
                        }
                        const uriDocument: vscode.Uri = vscode.Uri.file(newPath);
                        vscode.workspace.openTextDocument(uriDocument).then(doc => {
                            vscode.window.showTextDocument(doc).then(editor => {
                                revealLine(parseInt(selection.label, 10) - 1);
                            });
                        });
                    }
                });
            }
        );
    });

    function revealLine(line: number, directJump?: boolean) {
        const newSe = new vscode.Selection(line, 0, line, 0);
        vscode.window.activeTextEditor.selection = newSe;
        if (directJump) {
            vscode.window.activeTextEditor.revealRange(newSe, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } else {
            vscode.window.activeTextEditor.revealRange(newSe, vscode.TextEditorRevealType.InCenter);
        }
    }

    function canSaveBookmarksInProject(): boolean {
        let saveBookmarksInProject: boolean = vscode.workspace.getConfiguration("numberedBookmarks").get("saveBookmarksInProject", false);
        
        // really use saveBookmarksInProject
        // 0. has at least a folder opened
        // 1. is a valid workspace/folder
        // 2. has only one workspaceFolder
        // let hasBookmarksFile: boolean = false;
        if (saveBookmarksInProject && ((!vscode.workspace.workspaceFolders) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1))) {
            saveBookmarksInProject = false;
        }

        return saveBookmarksInProject;
    }

    async function loadWorkspaceState(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
        const saveBookmarksInProject: boolean = canSaveBookmarksInProject();

        controller = new Controller(workspaceFolder); // vscode.workspace.getWorkspaceFolder(uri));

        if (saveBookmarksInProject) {
            if (!vscode.workspace.workspaceFolders) {
                return false;
            }

            // const bookmarksFileInProject: string = path.join(workspaceFolder.uri.fsPath, ".vscode", "numbered-bookmarks.json");
            // if (!fs.existsSync(bookmarksFileInProject)) {
            //     return false;
            // }
            const bookmarksFileInProject = appendPath(appendPath(vscode.workspace.workspaceFolders[0].uri, ".vscode"), "numbered-bookmarks.json");
            if (!uriExists(bookmarksFileInProject)) {
                return false;
            }
            
            try {
                const contents = await readFileUri(bookmarksFileInProject);
                controller.loadFrom(contents, true);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage("Error loading Numbered Bookmarks: " + error.toString());
                return false;
            }
        } else {
            const savedBookmarks = context.workspaceState.get("numberedBookmarks", "");
            if (savedBookmarks !== "") {
                controller.loadFrom(JSON.parse(savedBookmarks));
            }
            return savedBookmarks !== "";
        }
    }

    function loadBookmarks(workspaceFolder: vscode.WorkspaceFolder): Controller {
        const saveBookmarksInProject: boolean = canSaveBookmarksInProject();

        const newController = new Controller(workspaceFolder);

        if (saveBookmarksInProject) {
            const bookmarksFileInProject: string = path.join(workspaceFolder.uri.fsPath, ".vscode", "numbered-bookmarks.json");
            if (!fs.existsSync(bookmarksFileInProject)) {
                return newController;
            }
            
            try {
                newController.loadFrom(JSON.parse(fs.readFileSync(bookmarksFileInProject).toString()), true);
                return newController;
            } catch (error) {
                vscode.window.showErrorMessage("Error loading Numbered Bookmarks: " + error.toString());
                return newController;
            }
        } else {
            const savedBookmarks = context.workspaceState.get("numberedBookmarks", "");
            if (savedBookmarks !== "") {
                newController.loadFrom(JSON.parse(savedBookmarks));
            }
            return newController;
        }
    }    

    function saveWorkspaceState(): void {
        // return;
        const saveBookmarksInProject: boolean = canSaveBookmarksInProject();

        if (saveBookmarksInProject) {
            //const bookmarksFileInProject: string = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".vscode", "numbered-bookmarks.json");
            // if (!fs.existsSync(path.dirname(bookmarksFileInProject))) {
            //     fs.mkdirSync(path.dirname(bookmarksFileInProject));
            // }
            // fs.writeFileSync(bookmarksFileInProject, JSON.stringify(controller.zip(), null, "\t"));
            const bookmarksFileInProject = appendPath(appendPath(vscode.workspace.workspaceFolders[0].uri, ".vscode"), "numbered-bookmarks.json");
            if (!uriExists(appendPath(vscode.workspace.workspaceFolders[0].uri, ".vscode"))) {
                createDirectoryUri(appendPath(vscode.workspace.workspaceFolders[0].uri, ".vscode"));
            }
            writeFileUri(bookmarksFileInProject, JSON.stringify(controller.zip(), null, "\t"));
        } else {
            context.workspaceState.update("numberedBookmarks", JSON.stringify(controller.zip()));
        }
    }

    function toggleBookmark(n: number, line: number) {
        // fix issue emptyAtLaunch
        if (!activeBookmark) {
            controller.addFile(vscode.window.activeTextEditor.document.uri); // .fsPath);
            activeBookmark = controller.fromUri(vscode.window.activeTextEditor.document.uri);
        }

        // there is another bookmark already set for this line?
        const index: number = activeBookmark.bookmarks.indexOf(line);
        if (index >= 0) {
            clearBookmark(index);
        }

        // if was myself, then I want to 'remove'
        if (index !== n) {
            activeBookmark.bookmarks[ n ] = line;

            // when _toggling_ only "replace" differs, because it has to _invalidate_ that bookmark from other files 
            const navigateThroughAllFiles: string = vscode.workspace.getConfiguration("numberedBookmarks").get("navigateThroughAllFiles", "false");
            if (navigateThroughAllFiles === "replace") {
                // for (let index = 0; index < bookmarks.bookmarks.length; index++) {
                //     let element = bookmarks.bookmarks[ index ];
                for (const element of controller.files) {
                    if (element.path !== activeBookmark.path) {
                        element.bookmarks[ n ] = NO_BOOKMARK_DEFINED;
                    }
                }
            }
        }

        saveWorkspaceState();
        updateDecorations();
    }

    function clearBookmark(n: number) {
        activeBookmark.bookmarks[ n ] = NO_BOOKMARK_DEFINED;
    }

    function jumpToBookmark(n: number) {
        if (!activeBookmark) {
            return;
        }

        // when _jumping_ each config has its own behavior 
        const navigateThroughAllFiles: string = vscode.workspace.getConfiguration("numberedBookmarks").get("navigateThroughAllFiles", "false");
        switch (navigateThroughAllFiles) {
            case "replace":
                // is it already set?
                if (activeBookmark.bookmarks[ n ] < 0) {

                    // no, look for another document that contains that bookmark 
                    // I can start from the first because _there is only one_
                    // for (let index = 0; index < bookmarks.bookmarks.length; index++) {
                    //     let element = bookmarks.bookmarks[ index ];
                    for (const element of controller.files) {
                        if ((element.path !== activeBookmark.path) && (element.bookmarks[ n ] !== NO_BOOKMARK_DEFINED)) {
                            // open and novigate
                            const uriDocument: vscode.Uri = vscode.Uri.file(element.path);
                            vscode.workspace.openTextDocument(uriDocument).then(doc => {
                                vscode.window.showTextDocument(doc, undefined, false).then(editor => {
                                    revealLine(element.bookmarks[ n ]);
                                });
                            });
                        }
                    }
                } else {
                    revealLine(activeBookmark.bookmarks[ n ], true);
                }

                break;

            case "allowDuplicates":

                // this file has, and I'm not in the line
                if ((activeBookmark.bookmarks[ n ] > NO_BOOKMARK_DEFINED) &&
                    (activeBookmark.bookmarks[ n ] !== vscode.window.activeTextEditor.selection.active.line)) {
                    revealLine(activeBookmark.bookmarks[ n ], true);
                    break;
                }

                // no, look for another document that contains that bookmark 
                // I CAN'T start from the first because _there can be duplicates_
                const currentFile: number = controller.indexFromPath(activeBookmark.path);
                let found: boolean = false;

                // to the end
                for (let index = currentFile; index < controller.files.length; index++) {
                    const element = controller.files[ index ];
                    if ((!found) && (element.path !== activeBookmark.path) && (element.bookmarks[ n ] !== NO_BOOKMARK_DEFINED)) {
                        found = true;
                        // open and novigate
                        const uriDocument: vscode.Uri = vscode.Uri.file(element.path);
                        vscode.workspace.openTextDocument(uriDocument).then(doc => {
                            vscode.window.showTextDocument(doc, undefined, false).then(editor => {
                                revealLine(element.bookmarks[ n ]);
                            });
                        });
                    }
                }

                if (!found) {
                    for (let index = 0; index < currentFile; index++) {
                        const element = controller.files[ index ];
                        if ((!found) && (element.path !== activeBookmark.path) && (element.bookmarks[ n ] !== NO_BOOKMARK_DEFINED)) {
                            // open and novigate
                            found = true;
                            const uriDocument: vscode.Uri = vscode.Uri.file(element.path);
                            vscode.workspace.openTextDocument(uriDocument).then(doc => {
                                vscode.window.showTextDocument(doc, undefined, false).then(editor => {
                                    revealLine(element.bookmarks[ n ]);
                                });
                            });
                        }
                    }
                }

                break;

            default: // "false"
                // is it already set?
                if (activeBookmark.bookmarks[ n ] < 0) {
                    vscode.window.setStatusBarMessage("The Bookmark " + n + " is not defined", 3000);
                    return;
                }
                revealLine(activeBookmark.bookmarks[ n ], true);

                break;
        }
    }

    function removeBasePathFrom(aPath: string, currentWorkspaceFolder: vscode.WorkspaceFolder): string {
        if (!vscode.workspace.workspaceFolders) {
            return aPath;
        }

        let inWorkspace: vscode.WorkspaceFolder;
        for (const wf of vscode.workspace.workspaceFolders) {
            if (aPath.indexOf(wf.uri.fsPath) === 0) {
                inWorkspace = wf;
            }
        }

        if (inWorkspace) {
            if (inWorkspace === currentWorkspaceFolder) {
                return aPath.split(inWorkspace.uri.fsPath).pop();
            } else {
                if (!currentWorkspaceFolder && vscode.workspace.workspaceFolders.length === 1) {
                    return aPath.split(inWorkspace.uri.fsPath).pop();
                } else {
                    return "$(file-submodule) " + inWorkspace.name + /*path.sep + */aPath.split(inWorkspace.uri.fsPath).pop();
                }
            }
            // const base: string = inWorkspace.name ? inWorkspace.name : inWorkspace.uri.fsPath;
            // return path.join(base, aPath.split(inWorkspace.uri.fsPath).pop());
            // return aPath.split(inWorkspace.uri.fsPath).pop();
        } else {
            return "$(file-directory) " + aPath;
        }
    }
}