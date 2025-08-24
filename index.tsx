import React, { useState, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Since JSZip is loaded from a CDN, declare it for TypeScript
declare var JSZip: any;

const h = React.createElement;
const MAX_FILES = 20;

const App = () => {
    const [files, setFiles] = useState<File[]>([]);
    const [knowledgeFiles, setKnowledgeFiles] = useState<File[]>([]);
    const [projectName, setProjectName] = useState('generated-spring-project');
    const [isLoading, setIsLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [resultUrl, setResultUrl] = useState<string | null>(null);

    const ai = useMemo(() => process.env.API_KEY ? new GoogleGenAI({ apiKey: process.env.API_KEY }) : null, []);

    const createFileChangeHandler = (
        setFilesState: React.Dispatch<React.SetStateAction<File[]>>,
        allowedTypes: string[],
        allowedExtensions: string[],
        errorMessage: string
    ) => (newFiles: FileList | null) => {
        if (!newFiles) return;

        const acceptedFiles = Array.from(newFiles).filter(file =>
            allowedTypes.includes(file.type) || allowedExtensions.some(ext => file.name.endsWith(ext))
        );

        if (acceptedFiles.length !== newFiles.length && newFiles.length > 0) {
            setError(errorMessage);
        } else {
            setError(null);
        }

        setFilesState(prevFiles => {
            const combined = [...prevFiles];
            acceptedFiles.forEach(file => {
                if (!combined.some(f => f.name === file.name)) {
                    combined.push(file);
                }
            });
            if (combined.length > MAX_FILES) {
                setError(`You can upload a maximum of ${MAX_FILES} files.`);
                return combined.slice(0, MAX_FILES);
            }
            return combined;
        });
    };
    
    const handleXmlFileChange = createFileChangeHandler(setFiles, ['text/xml'], ['.xml'], 'Please upload only XML files.');
    const handleKnowledgeFileChange = createFileChangeHandler(setKnowledgeFiles, ['text/plain', 'text/markdown'], ['.txt', '.md'], 'Please upload only .txt or .md files for knowledge documents.');

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');
    };

    const onDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
    };
    
    const createDropHandler = (handler: (files: FileList | null) => void) => (e: React.DragEvent) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        handler(e.dataTransfer.files);
    };

    const onXmlDrop = createDropHandler(handleXmlFileChange);
    const onKnowledgeDrop = createDropHandler(handleKnowledgeFileChange);

    const createSelectHandler = (handler: (files: FileList | null) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
        handler(e.target.files);
        e.target.value = ''; // Reset input to allow re-selecting the same file
    };
    
    const onXmlFileSelect = createSelectHandler(handleXmlFileChange);
    const onKnowledgeFileSelect = createSelectHandler(handleKnowledgeFileChange);


    const removeFile = (fileName: string) => {
        setFiles(files.filter(file => file.name !== fileName));
    };
    
    const removeKnowledgeFile = (fileName: string) => {
        setKnowledgeFiles(knowledgeFiles.filter(file => file.name !== fileName));
    };

    const resetState = () => {
        setFiles([]);
        setKnowledgeFiles([]);
        setProjectName('generated-spring-project');
        setIsLoading(false);
        setProgress(0);
        setStatusMessage('');
        setError(null);
        if (resultUrl) {
            URL.revokeObjectURL(resultUrl);
        }
        setResultUrl(null);
    };

    const handleConvert = async () => {
        if (!files.length || isLoading) return;
        if (!ai) {
            setError("API key is not configured. Please set the API_KEY environment variable.");
            return;
        }

        setIsLoading(true);
        setError(null);
        setResultUrl(null);
        setProgress(0);

        try {
            setStatusMessage('Analyzing files...');
            const xmlFileContents = await Promise.all(
                files.map(async (file) => ({ name: file.name, content: await file.text() }))
            );
            const knowledgeFileContents = await Promise.all(
                knowledgeFiles.map(async (file) => ({ name: file.name, content: await file.text() }))
            );

            const safeProjectName = projectName.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || 'defaultproject';
            const basePackage = `com.example.${safeProjectName.replace(/-/g, '')}`;
            
            let knowledgeContext = '';
            if (knowledgeFileContents.length > 0) {
                knowledgeContext = `
**Contextual Knowledge & Guidelines:**
Use the following documents as your primary source of truth. These guidelines, standards, and examples MUST be prioritized over your general knowledge when generating the project.
${knowledgeFileContents.map(f => `\n--- START OF DOCUMENT: ${f.name} ---\n${f.content}\n--- END OF DOCUMENT: ${f.name} ---\n`).join('')}
`;
            }

            const prompt = `
You are an expert Spring Boot developer tasked with creating a complete, runnable Spring Boot project from a set of XML files.
${knowledgeContext}
**Project Requirements:**
1.  **Build Tool:** Use Maven. Generate a complete \`pom.xml\`.
2.  **Spring Boot Version:** Use a recent, stable version of Spring Boot (e.g., 3.x).
3.  **Dependencies:**
    *   Include \`spring-boot-starter-web\`.
    *   Include JAXB dependencies (\`jakarta.xml.bind-api\` and \`jaxb-runtime\`).
4.  **Package Structure:** Use the base package name: \`${basePackage}\`.
5.  **Main Application Class:** Create a standard Spring Boot main application class inside the base package.
6.  **XML Models:** For each provided XML file, generate a corresponding Java POJO class in a \`${basePackage}.model\` sub-package. Annotate the classes with JAXB annotations (\`@XmlRootElement\`, \`@XmlElement\`, etc.) to match the XML structure.
7.  **REST Controller:** Create a simple REST controller in a \`${basePackage}.controller\` package. This controller should have a GET endpoint that returns a sample instance of one of the generated models.
8.  **Configuration:** Generate a basic \`src/main/resources/application.properties\` file.

**Input XML Files:**
\`\`\`json
${JSON.stringify(xmlFileContents, null, 2)}
\`\`\`

**Output Format:**
Your response MUST be a single JSON object that conforms to the provided JSON schema. Do not include any explanatory text, markdown formatting, or anything outside of the JSON object.
`;

            const schema = {
                type: Type.OBJECT,
                properties: {
                    files: {
                        type: Type.ARRAY,
                        description: 'An array of file objects representing the project structure.',
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                path: {
                                    type: Type.STRING,
                                    description: 'The full path of the file relative to the project root, e.g., "pom.xml" or "src/main/java/com/example/demo/DemoApplication.java".'
                                },
                                content: {
                                    type: Type.STRING,
                                    description: 'The complete content of the file as a string.'
                                }
                            },
                            required: ['path', 'content']
                        }
                    }
                },
                required: ['files']
            };
            
            setProgress(25);
            setStatusMessage('Generating Spring Boot project... This may take a moment.');

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: schema,
                },
            });

            setProgress(75);
            setStatusMessage('Zipping project files...');

            const projectStructure = JSON.parse(response.text);

            if (!projectStructure.files || !Array.isArray(projectStructure.files)) {
                throw new Error("AI response was not in the expected format. Please try again.");
            }

            const zip = new JSZip();
            const projectFolder = zip.folder(projectName);

            projectStructure.files.forEach((file: { path: string, content: string }) => {
                projectFolder.file(file.path, file.content);
            });

            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(zipBlob);

            setResultUrl(url);
            setStatusMessage('Project generated successfully!');
            setProgress(100);


        } catch (e) {
            console.error(e);
            setError(e instanceof Error ? `Generation failed: ${e.message}` : 'An unknown error occurred during conversion.');
            setProgress(0);
        } finally {
            setIsLoading(false);
        }
    };
    
    const renderContent = () => {
        if(isLoading) {
            return h('div', { className: 'progress-section' },
                h('div', { className: 'progress-bar-container' },
                    h('div', { className: 'progress-bar', style: { width: `${progress}%` } })
                ),
                h('p', { className: 'status-message' }, statusMessage)
            );
        }
        if (resultUrl) {
            return h('div', { className: 'result-section success' },
                h('h2', null, '🎉 Congratulations!'),
                h('p', { className: 'message' }, 'Your Spring Boot project has been successfully generated.'),
                h('div', { className: 'result-buttons' },
                    h('a', { href: resultUrl, download: `${projectName}.zip`, className: 'btn btn-primary' }, 'Download Project ZIP'),
                    h('button', { onClick: resetState, className: 'btn btn-secondary' }, 'Start Over')
                )
            );
        }
        if (error) {
            return h('div', { className: 'result-section error' },
                h('h2', null, 'Generation Failed'),
                h('p', { className: 'message' }, error),
                h('div', { className: 'result-buttons' },
                    h('button', { onClick: resetState, className: 'btn btn-secondary' }, 'Try Again')
                )
            );
        }

        const uploadIcon = h('svg', { className: "drop-zone-icon", xmlns: "http://www.w3.org/2000/svg", fill: "none", viewBox: "0 0 24 24", strokeWidth: 1.5, stroke: "currentColor" },
            h('path', { strokeLinecap: "round", strokeLinejoin: "round", d: "M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" })
        );
        
        const docIcon = h('svg', { className: "drop-zone-icon secondary", xmlns: "http://www.w3.org/2000/svg", fill: "none", viewBox: "0 0 24 24", strokeWidth: 1.5, stroke: "currentColor" },
             h('path', { strokeLinecap: "round", strokeLinejoin: "round", d: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" })
        );


        const deleteIcon = h('svg', { xmlns: "http://www.w3.org/2000/svg", fill: "none", viewBox: "0 0 24 24", strokeWidth: 2, stroke: "currentColor", width: "20", height: "20" },
            h('path', { strokeLinecap: "round", strokeLinejoin: "round", d: "M6 18 18 6M6 6l12 12" })
        );
        
        const renderFileList = (fileList: File[], removeFn: (name: string) => void) => {
            if (fileList.length === 0) return null;
            return h('div', { className: 'file-list-container' },
               fileList.map(file => h('div', { key: file.name, className: 'file-list-item' },
                    h('div', { className: 'file-info' },
                        h('span', null, file.name), `(${(file.size / 1024).toFixed(2)} KB)`
                    ),
                    h('button', { onClick: () => removeFn(file.name), className: 'delete-btn', 'aria-label': `Remove ${file.name}` }, deleteIcon)
               ))
            );
        };

        return h(React.Fragment, null,
            h('div', { className: 'upload-section' },
                h('div', { className: 'upload-area' },
                    h('h3', { className: 'upload-title' }, '1. Upload XML Files'),
                    h('input', { type: 'file', id: 'file-input', multiple: true, accept: '.xml,text/xml', onChange: onXmlFileSelect, style: { display: 'none' } }),
                    h('div', { className: 'drop-zone', onClick: () => document.getElementById('file-input')?.click(), onDrop: onXmlDrop, onDragOver: onDragOver, onDragLeave: onDragLeave },
                        uploadIcon,
                        h('p', null, 'Drag & drop XML files here, or ', h('span', null, 'click to select'), '.')
                    ),
                    renderFileList(files, removeFile)
                ),
                 h('div', { className: 'upload-area' },
                    h('h3', { className: 'upload-title' }, '2. Add Knowledge Documents (Optional)'),
                    h('input', { type: 'file', id: 'knowledge-file-input', multiple: true, accept: '.txt,.md,text/plain,text/markdown', onChange: onKnowledgeFileSelect, style: { display: 'none' } }),
                    h('div', { className: 'drop-zone secondary', onClick: () => document.getElementById('knowledge-file-input')?.click(), onDrop: onKnowledgeDrop, onDragOver: onDragOver, onDragLeave: onDragLeave },
                        docIcon,
                        h('p', null, 'Drop .txt or .md guidelines, or ', h('span', null, 'click to select'), '.')
                    ),
                    renderFileList(knowledgeFiles, removeKnowledgeFile)
                )
            ),
            
            files.length > 0 && h('div', { className: 'config-section' },
                h('h3', { className: 'upload-title' }, '3. Configure & Generate'),
                h('div', { className: 'input-group' },
                    h('label', { htmlFor: 'project-name' }, 'Spring Project Name'),
                    h('input', { type: 'text', id: 'project-name', value: projectName, onChange: (e) => setProjectName(e.target.value.replace(/\.zip/,'')) })
                ),
                h('button', { className: 'btn btn-primary', onClick: handleConvert, disabled: !files.length || isLoading },
                    isLoading ? h('div', { className: 'spinner' }) : null,
                    isLoading ? 'Generating...' : 'Generate Spring Project'
                )
            )
        );
    };

    return h('div', { className: 'app-container' },
        h('header', { className: 'header' },
            h('h1', null, 'XML to Spring Project Converter'),
            h('p', null, 'Instantly convert your XML files into a complete Spring Boot project using AI.')
        ),
        h('main', null, renderContent())
    );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(h(React.StrictMode, null, h(App, null)));