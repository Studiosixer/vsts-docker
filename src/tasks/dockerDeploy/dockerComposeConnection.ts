"use strict";

import * as del from "del";
import * as fs from "fs";
import * as path from "path";
import * as tl from "vsts-task-lib/task";
import * as tr from "vsts-task-lib/toolrunner";
import * as yaml from "js-yaml";
import DockerConnection from "./dockerConnection";

export default class DockerComposeConnection extends DockerConnection {
    private dockerComposePath: string;
    private dockerComposeFile: string;
    private additionalDockerComposeFiles: string[];
    private requireAdditionalDockerComposeFiles: boolean;
    private projectName: string;
    private finalComposeFile: string;

    constructor() {
        super();
        this.dockerComposePath = tl.which("docker-compose", true);
        this.dockerComposeFile = tl.globFirst(tl.getInput("dockerComposeFile", true));
        this.additionalDockerComposeFiles = tl.getDelimitedInput("additionalDockerComposeFiles", "\n");
        this.requireAdditionalDockerComposeFiles = tl.getBoolInput("requireAdditionalDockerComposeFiles");
        this.projectName = tl.getInput("projectName");
    }

    public open(hostEndpoint?: string, registryEndpoint?: string): any {
        super.open(hostEndpoint, registryEndpoint);

        if (this.hostUrl) {
            process.env["DOCKER_HOST"] = this.hostUrl;
            process.env["DOCKER_TLS_VERIFY"] = 1;
            process.env["DOCKER_CERT_PATH"] = this.certsDir;
        }

        tl.getDelimitedInput("dockerComposeFileArgs", "\n").forEach(envVar => {
            var tokens = envVar.split("=");
            if (tokens.length < 2) {
                throw new Error("Environment variable '" + envVar + "' is invalid.");
            }
            process.env[tokens[0].trim()] = tokens.slice(1).join("=").trim();
        });

        return this.getImages(true).then(images => {
            var qualifyImageNames = tl.getBoolInput("qualifyImageNames");
            if (!qualifyImageNames) {
                return;
            }
            var agentDirectory = tl.getVariable("Agent.HomeDirectory");
            this.finalComposeFile = path.join(agentDirectory, ".docker-compose." + Date.now() + ".yml");
            var services = {};
            if (qualifyImageNames) {
                for (var serviceName in images) {
                    images[serviceName] = this.qualifyImageName(images[serviceName]);
                }
            }
            for (var serviceName in images) {
                services[serviceName] = {
                    image: images[serviceName]
                };
            }
            fs.writeFileSync(this.finalComposeFile, yaml.safeDump({
                version: "2",
                services: services
            }, { lineWidth: -1 } as any));
        });
    }

    public createComposeCommand(): tr.ToolRunner {
        var command = tl.tool(this.dockerComposePath);

        command.arg(["-f", this.dockerComposeFile]);

        var basePath = path.dirname(this.dockerComposeFile);
        this.additionalDockerComposeFiles.forEach(file => {
            // If the path is relative, resolve it
            if (file.indexOf("/") !== 0) {
                file = path.join(basePath, file);
            }
            if (this.requireAdditionalDockerComposeFiles || tl.exist(file)) {
                command.arg(["-f", file]);
            }
        });
        if (this.finalComposeFile) {
            command.arg(["-f", this.finalComposeFile]);
        }

        if (this.projectName) {
            command.arg(["-p", this.projectName]);
        }

        return command;
    }

    public getCombinedConfig(imageDigestComposeFile?: string): any {
        var command = this.createComposeCommand();
        if (imageDigestComposeFile) {
            command.arg(["-f", imageDigestComposeFile]);
        }
        command.arg("config");
        var result = "";
        command.on("stdout", data => {
            result += data;
        });
        command.on("errline", line => {
            tl.error(line);
        });
        return command.exec({ silent: true } as any).then(() => result);
    }

    public getImages(builtOnly?: boolean): any {
        return this.getCombinedConfig().then(input => {
            var doc = yaml.safeLoad(input);
            var projectName = this.projectName;
            if (!projectName) {
                projectName = path.basename(path.dirname(this.dockerComposeFile));
            }
            var images: any = {};
            for (var serviceName in doc.services || {}) {
                var service = doc.services[serviceName];
                var image = service.image;
                if (!image) {
                    image = projectName.toLowerCase().replace(/[^0-9a-z]/g, "") + "_" + serviceName;
                }
                if (!builtOnly || service.build) {
                    images[serviceName] = image;
                }
            }
            return images;
        });
    }

    public close(): void {
        if (this.finalComposeFile && tl.exist(this.finalComposeFile)) {
            del.sync(this.finalComposeFile, { force: true });
        }
        super.close();
    }
}
