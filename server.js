const express = require("express");
const cors = require("cors");
const dns = require("dns").promises;
const net = require("net");

const app = express();

const PORT = process.env.PORT || 10000;

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT = 20000;
const MAX_HTML_SIZE = 15 * 1024 * 1024;


/*
========================================
CORS
========================================
*/

app.use(
    cors({
        origin: "*",
        methods: ["GET", "OPTIONS"],
        allowedHeaders: ["Content-Type"]
    })
);


/*
========================================
HEALTH CHECK
========================================
*/

app.get("/health", (req, res) => {

    res.json({
        success: true,
        service: "Website Checker Pro",
        status: "online"
    });

});


/*
========================================
VALIDATE URL
========================================
*/

function validateURL(value){

    let url;

    try{

        url = new URL(value);

    }catch{

        throw new Error(
            "Invalid URL."
        );

    }


    if(
        url.protocol !== "http:" &&
        url.protocol !== "https:"
    ){

        throw new Error(
            "Only HTTP and HTTPS URLs are allowed."
        );

    }


    if(
        !url.hostname ||
        url.hostname.length > 253
    ){

        throw new Error(
            "Invalid hostname."
        );

    }


    return url;

}


/*
========================================
BLOCK PRIVATE IP
========================================
*/

function isPrivateIP(ip){

    if(net.isIPv4(ip)){

        const parts =
            ip.split(".")
              .map(Number);

        const a = parts[0];
        const b = parts[1];


        if(a === 10){
            return true;
        }

        if(
            a === 172 &&
            b >= 16 &&
            b <= 31
        ){
            return true;
        }

        if(
            a === 192 &&
            b === 168
        ){
            return true;
        }

        if(a === 127){
            return true;
        }

        if(
            a === 169 &&
            b === 254
        ){
            return true;
        }

        if(a === 0){
            return true;
        }

        return false;

    }


    if(net.isIPv6(ip)){

        const normalized =
            ip.toLowerCase();

        if(normalized === "::1"){
            return true;
        }

        if(
            normalized.startsWith("fc") ||
            normalized.startsWith("fd")
        ){
            return true;
        }

        if(
            normalized.startsWith("fe80:")
        ){
            return true;
        }

        return false;

    }


    return true;

}


/*
========================================
CHECK HOST DNS
========================================
*/

async function validateHost(url){

    const hostname =
        url.hostname;


    const lower =
        hostname.toLowerCase();


    const blockedNames = [
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
        "metadata",
        "host.docker.internal"
    ];


    if(
        blockedNames.includes(lower)
    ){

        throw new Error(
            "This host is not allowed."
        );

    }


    /*
    Direct IP
    */

    if(net.isIP(hostname)){

        if(isPrivateIP(hostname)){

            throw new Error(
                "Private or local IP addresses are not allowed."
            );

        }

        return;

    }


    /*
    DNS lookup
    */

    const addresses =
        await dns.lookup(
            hostname,
            {
                all:true,
                verbatim:true
            }
        );


    if(!addresses.length){

        throw new Error(
            "Hostname could not be resolved."
        );

    }


    for(
        const item of addresses
    ){

        if(
            isPrivateIP(
                item.address
            )
        ){

            throw new Error(
                "The requested host resolves to a private/local IP and is not allowed."
            );

        }

    }

}


/*
========================================
FETCH WEBSITE
========================================
*/

async function fetchWebsite(
    inputURL
){

    let currentURL =
        inputURL;


    for(
        let redirectCount = 0;
        redirectCount <= MAX_REDIRECTS;
        redirectCount++
    ){

        const url =
            validateURL(
                currentURL
            );


        await validateHost(
            url
        );


        const controller =
            new AbortController();


        const timer =
            setTimeout(
                () => controller.abort(),
                REQUEST_TIMEOUT
            );


        let response;


        try{

            response =
                await fetch(
                    url.href,
                    {
                        method:"GET",

                        redirect:"manual",

                        signal:
                            controller.signal,

                        headers:{
                            "User-Agent":
                            "Mozilla/5.0 (compatible; WebsiteCheckerPro/1.0)",

                            "Accept":
                            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                        }
                    }
                );

        }catch(error){

            clearTimeout(timer);

            if(
                error.name ===
                "AbortError"
            ){

                throw new Error(
                    "Website request timed out."
                );

            }

            throw new Error(
                "Could not connect to the website."
            );

        }


        clearTimeout(timer);


        /*
        ========================================
        REDIRECT
        ========================================
        */

        if(
            response.status >= 300 &&
            response.status < 400
        ){

            const location =
                response.headers.get(
                    "location"
                );


            if(!location){

                throw new Error(
                    "Website returned a redirect without a destination."
                );

            }


            currentURL =
                new URL(
                    location,
                    url.href
                ).href;


            continue;

        }


        /*
        ========================================
        RESPONSE STATUS
        ========================================
        */

        const contentType =
            response.headers.get(
                "content-type"
            ) || "";


        if(
            response.status < 200 ||
            response.status >= 400
        ){

            throw new Error(
                `Website returned HTTP ${response.status}.`
            );

        }


        /*
        ========================================
        CONTENT TYPE
        ========================================
        */

        if(
            !contentType.includes("text/html") &&
            !contentType.includes("application/xhtml+xml")
        ){

            throw new Error(
                "The URL did not return an HTML page."
            );

        }


        /*
        ========================================
        READ BODY WITH SIZE LIMIT
        ========================================
        */

        const contentLength =
            Number(
                response.headers.get(
                    "content-length"
                ) || 0
            );


        if(
            contentLength >
            MAX_HTML_SIZE
        ){

            throw new Error(
                "HTML page is too large."
            );

        }


        const reader =
            response.body.getReader();


        const chunks = [];

        let total = 0;


        while(true){

            const {
                done,
                value
            } =
                await reader.read();


            if(done){
                break;
            }


            total +=
                value.byteLength;


            if(
                total >
                MAX_HTML_SIZE
            ){

                try{
                    await reader.cancel();
                }catch{}

                throw new Error(
                    "HTML page is larger than the allowed limit."
                );

            }


            chunks.push(
                value
            );

        }


        const merged =
            new Uint8Array(
                total
            );


        let offset = 0;


        for(
            const chunk of chunks
        ){

            merged.set(
                chunk,
                offset
            );

            offset +=
                chunk.byteLength;

        }


        const html =
            new TextDecoder(
                "utf-8"
            ).decode(
                merged
            );


        return {

            html,
            url:url.href,
            status:response.status,
            statusText:response.statusText,
            contentType

        };

    }


    throw new Error(
        "Too many redirects."
    );

}


/*
========================================
FETCH API
========================================
*/

app.get(
    "/api/fetch",
    async(req,res)=>{

        try{

            const target =
                req.query.url;


            if(!target){

                return res
                    .status(400)
                    .json({
                        success:false,
                        error:
                        "URL is required."
                    });

            }


            const result =
                await fetchWebsite(
                    target
                );


            res.json({

                success:true,

                url:
                    result.url,

                status:
                    `${result.status} ${result.statusText}`,

                contentType:
                    result.contentType,

                html:
                    result.html

            });

        }catch(error){

            console.error(
                "FETCH ERROR:",
                error
            );


            res
                .status(400)
                .json({
                    success:false,
                    error:
                        error.message ||
                        "Unable to fetch website."
                });

        }

    }
);


/*
========================================
PREVIEW API
========================================
*/

app.get(
    "/api/preview",
    async(req,res)=>{

        try{

            const target =
                req.query.url;


            if(!target){

                return res
                    .status(400)
                    .send(
                        "URL is required."
                    );

            }


            const result =
                await fetchWebsite(
                    target
                );


            let html =
                result.html;


            /*
            Add base URL so relative
            CSS/images/scripts can resolve.
            */

            const baseTag =
                `<base href="${escapeAttribute(result.url)}">`;


            if(
                /<head[^>]*>/i.test(html)
            ){

                html =
                    html.replace(
                        /<head([^>]*)>/i,
                        `<head$1>${baseTag}`
                    );

            }else{

                html =
                    `<!DOCTYPE html>
                    <html>
                    <head>${baseTag}</head>
                    <body>
                    ${html}
                    </body>
                    </html>`;

            }


            res
                .status(200)
                .set(
                    "Content-Type",
                    "text/html; charset=utf-8"
                )
                .set(
                    "X-Frame-Options",
                    "SAMEORIGIN"
                )
                .send(
                    html
                );


        }catch(error){

            res
                .status(400)
                .set(
                    "Content-Type",
                    "text/html; charset=utf-8"
                )
                .send(`
                    <!DOCTYPE html>
                    <html>
                    <body style="
                        font-family:Arial;
                        padding:30px;
                        background:#111;
                        color:white;
                    ">
                        <h2>❌ Preview Error</h2>
                        <p>
                            ${escapeHTML(
                                error.message ||
                                "Unable to load preview."
                            )}
                        </p>
                    </body>
                    </html>
                `);

        }

    }
);


/*
========================================
ESCAPE HTML
========================================
*/

function escapeHTML(value){

    return String(value)
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");

}


/*
========================================
ESCAPE ATTRIBUTE
========================================
*/

function escapeAttribute(value){

    return String(value)
        .replace(/&/g,"&amp;")
        .replace(/"/g,"&quot;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;");

}


/*
========================================
ROOT
========================================
*/

app.get("/",(req,res)=>{

    res.json({

        name:
            "Website Checker Pro",

        status:
            "online",

        endpoints:[
            "/health",
            "/api/fetch?url=https://example.com",
            "/api/preview?url=https://example.com"
        ]

    });

});


/*
========================================
START SERVER
========================================
*/

app.listen(
    PORT,
    "0.0.0.0",
    ()=>{
        console.log(
            `Website Checker Pro running on port ${PORT}`
        );
    }
);
