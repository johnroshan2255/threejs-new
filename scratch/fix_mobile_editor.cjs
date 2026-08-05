const fs = require('fs');

// --- 1. Modify EditModeUI.ts ---
let ts = fs.readFileSync('src/ui/EditModeUI.ts', 'utf8');

// Add HTML button
if (!ts.includes('id="edit-mobile-tools-toggle"')) {
    ts = ts.replace(
        '<button type="button" class="edit-mode-toggle" id="edit-mode-toggle" title="Edit Mode">Edit Mode</button>',
        '<button type="button" class="edit-mode-toggle" id="edit-mode-toggle" title="Edit Mode">Edit Mode</button>\n\t\t\t<button type="button" class="edit-mobile-tools-toggle" id="edit-mobile-tools-toggle" title="Toggle Tools">🛠️ Tools</button>'
    );
}

// Add TS property
if (!ts.includes('private readonly toolsToggleBtn: HTMLButtonElement;')) {
    ts = ts.replace(
        'private readonly editBtn: HTMLButtonElement;',
        'private readonly editBtn: HTMLButtonElement;\n\tprivate readonly toolsToggleBtn: HTMLButtonElement;'
    );
}

// Add event listener
if (!ts.includes('this.toolsToggleBtn = this.root.querySelector("#edit-mobile-tools-toggle")!;')) {
    ts = ts.replace(
        'this.editBtn = this.root.querySelector("#edit-mode-toggle")!;',
        'this.editBtn = this.root.querySelector("#edit-mode-toggle")!;\n\t\tthis.toolsToggleBtn = this.root.querySelector("#edit-mobile-tools-toggle")!;\n\t\tthis.toolsToggleBtn.addEventListener("click", () => {\n\t\t\tthis.root.classList.toggle("is-tools-hidden");\n\t\t});'
    );
}

fs.writeFileSync('src/ui/EditModeUI.ts', ts);
console.log("Updated EditModeUI.ts");


// --- 2. Modify style.css ---
let css = fs.readFileSync('src/style.css', 'utf8');

const oldMediaStart = css.indexOf('@media (max-width: 800px) {');
if (oldMediaStart !== -1) {
    // Find the end of this media query by matching braces
    let braceCount = 0;
    let oldMediaEnd = -1;
    for (let i = oldMediaStart; i < css.length; i++) {
        if (css[i] === '{') braceCount++;
        else if (css[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                oldMediaEnd = i + 1;
                break;
            }
        }
    }

    const newMedia = `/* Sidebar Toggle Button for Mobile */
.edit-mobile-tools-toggle {
	display: none;
	position: fixed;
	top: 10px;
	left: 10px;
	z-index: 10010;
	padding: 10px 15px;
	background: var(--edit-bg);
	border: 1px solid var(--edit-border);
	color: var(--edit-text);
	border-radius: 8px;
	font-weight: 600;
	font-family: var(--edit-font);
	box-shadow: 0 4px 12px rgba(0,0,0,0.5);
	cursor: pointer;
}

@media (max-width: 800px) {
	.edit-mode-active .edit-mobile-tools-toggle {
		display: block;
	}

	.edit-top-bar, .edit-left-bar {
		position: fixed !important;
		left: 0 !important;
		right: auto !important;
		width: 260px !important;
		border-radius: 0 !important;
		background: rgba(14, 22, 16, 0.95) !important;
		transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
		z-index: 10008 !important;
		border: none !important;
		border-right: 1px solid rgba(255,255,255,0.05) !important;
	}

	.edit-top-bar {
		top: 0 !important;
		bottom: auto !important;
		height: 40vh !important;
		padding-top: 60px !important; /* space for toggle button */
		border-bottom: 1px solid rgba(255,255,255,0.05) !important;
		display: block !important;
		overflow-y: auto !important;
	}

	.edit-left-bar {
		top: 40vh !important;
		bottom: 0 !important;
		height: 60vh !important;
		display: flex !important;
		flex-direction: column !important;
	}

	/* Stack the top bar tools vertically */
	.edit-top-scroll {
		flex-direction: column !important;
		align-items: stretch !important;
		width: 100% !important;
		height: auto !important;
		overflow-x: hidden !important;
		padding: 10px !important;
	}

	.edit-top-options, .edit-top-actions {
		flex-direction: column !important;
		align-items: stretch !important;
		width: 100% !important;
		margin-left: 0 !important;
	}

	/* Ensure the tools rail (Camera, Sculpt, etc) is vertical */
	.edit-tools-rail {
		flex-direction: column !important;
		width: 100% !important;
		height: auto !important;
		border-right: none !important;
		border-bottom: 1px solid rgba(255,255,255,0.1) !important;
	}
	.edit-tools-scroll {
		flex-direction: row !important;
		flex-wrap: wrap !important;
		gap: 6px !important;
		padding: 10px !important;
	}
	.edit-asset {
		flex: 1 1 40% !important;
		padding: 8px !important;
		text-align: center;
	}

	/* Hide mechanism */
	#edit-mode-ui.is-tools-hidden .edit-top-bar,
	#edit-mode-ui.is-tools-hidden .edit-left-bar {
		transform: translateX(-100%) !important;
	}
}
`;
    css = css.substring(0, oldMediaStart) + newMedia + css.substring(oldMediaEnd);
    fs.writeFileSync('src/style.css', css);
    console.log("Updated style.css");
} else {
    console.error("Could not find @media (max-width: 800px) block in style.css");
}
