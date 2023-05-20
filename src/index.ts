import "./env";
import { App } from "@slack/bolt";
import axios from "axios";
import fs from "fs";

const SLACK_ID = "U057975N5V5";

const tmdb = axios.create({
    baseURL: "https://api.themoviedb.org/3/",
    headers: {
        Authorization: `Bearer ${process.env.TMDB_API_TOKEN}`,
    },
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SIGNING_SECRET,
});

const QUEUE_PATH = "./data/queue.json";

type MovieNight = {
    host: string;
    date: Date;
};

type Movie = {
    title: string;
    requestor: string;
    plannedMovieNight?: MovieNight;
};

const movieQueue: Movie[] = JSON.parse(
    fs.readFileSync(QUEUE_PATH).toString()
).map((item: any) => {
    return {
        title: item.title,
        requestor: item.requestor,
        plannedMovieNight: item.plannedMovieNight
            ? {
                  host: item.plannedMovieNight.host,
                  date: new Date(item.plannedMovieNight.date),
              }
            : undefined,
    };
});

const flushMovieQueue = async () => {
    return new Promise((resolve, _) => {
        fs.writeFile(QUEUE_PATH, JSON.stringify(movieQueue), resolve);
    });
};

const templates = {
    foundMovie: [
        "One of my favorites–surely you mean the {0} classic {1}! To fill you in: {2}",
        "The best {0} had to offer, I'd say! If you meant {1}, that is! Here's the overview: {2}",
        "Of course, {1}! This {0} movie's about: {2}",
    ],
};

const chooseRandom = (args: any[]) =>
    args[Math.floor(Math.random() * args.length)];

const fillTemplate = (template: string, ...args: string[]): string => {
    return template.replace(/\{(\d+)\}/g, (match: string, number: number) => {
        return args[number];
    });
};

app.use(async ({ next }) => {
    await next();
});

app.message(async ({ message, client, say }) => {
    if (!("text" in message)) return;
    let text: string = message.text!;
    if (!text?.includes(SLACK_ID)) return;
    // TODO: Replace this with Regex–should be encoded explicitly as unicode
    text = text.replace(/’/g, "'").replaceAll("“", '"').replaceAll("”", '"');
    console.log("Got message", text);
    let matches;
    console.log("matches", matches);
    if (
        (matches =
            /(?:mo+vie|film|(?:motion|moving) picture) (?:list|queue)/i.exec(
                text
            ))
    ) {
        /* Movie queue management */
        await say({
            text: movieQueue.length
                ? `Sure thing! There ${
                      movieQueue.length > 1 ? "are" : "is"
                  } currently ${movieQueue.length} movie${
                      movieQueue.length > 1 ? "s" : ""
                  } in the queue:`
                : "The queue is currently empty, but feel free to add to it!",
            thread_ts: message.ts,
        });
        const templateMessage = await say("\u2002");
        await client.chat.update({
            channel: templateMessage.channel!,
            ts: templateMessage.ts!,
            thread_ts: templateMessage.ts,
            blocks: movieQueue.map((movie) => {
                return {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `_${movie.title}_ requested by <@${movie.requestor}>`,
                        },
                    ],
                };
            }),
            text: movieQueue.map((movie) => movie.title).join(", "),
        });
    } else if (
        (matches =
            /(?:search|look.*up|what's|what is|find)(?: (?:\"(.*)\"|_(.*)_)| (.*))/i.exec(
                text
            ))
    ) {
        /* Movie lookup */
        console.log("movie lookup", matches);
        const query = (matches![1] ?? matches![2] ?? matches![3]).replace(
            /\?/g,
            ""
        );
        const data = (
            await tmdb.get(
                `search/movie?query=${query}&include_adult=false&language=en-US&page=1`
            )
        ).data;
        const popularMovies = data.results.sort(
            (a: any, b: any) => b.vote_count - a.vote_count
        );
        if (popularMovies.length) {
            const movie = popularMovies[0];
            const year = movie.release_date.split("-")[0];
            await say({
                text: fillTemplate(
                    chooseRandom(templates.foundMovie),
                    year,
                    `_${movie.title}_`,
                    `\`\`\`${movie.overview}\`\`\``
                ),
                thread_ts: message.ts,
            });
        } else {
            await say({
                text: `Try as I might, I couldn't find '${query}.' Are you sure you spelled it right?`,
                thread_ts: message.ts,
            });
        }
    } else if (
        (matches = /(?:add|push) (?:(?:\"(.*)\"|_(.*)_)|(.*))/i.exec(text))
    ) {
        /* Add movies */
        console.log("movie lookup", matches);
        const query = (matches![1] ?? matches![2] ?? matches![3]).replace(
            /\?/g,
            ""
        );
        const data = (
            await tmdb.get(
                `search/movie?query=${query}&include_adult=false&language=en-US&page=1`
            )
        ).data;
        const popularMovies = data.results.sort(
            (a: any, b: any) => b.vote_count - a.vote_count
        );
        const forceAdd = text.includes("force");
        if (forceAdd) {
            movieQueue.push({
                title: query,
                requestor: message.user!,
            });
            await flushMovieQueue();
            await say({
                text: `Not sure if I've heard of it, but added '${query}' to the queue!`,
                thread_ts: message.ts,
            });
        } else {
            if (popularMovies.length) {
                const movie = popularMovies[0];
                const year = movie.release_date.split("-")[0];
                await say({
                    text: fillTemplate(
                        chooseRandom(templates.foundMovie),
                        year,
                        `_${movie.title}_`,
                        `\`\`\`${movie.overview}\`\`\``
                    ),
                    thread_ts: message.ts,
                });
                movieQueue.push({
                    title: movie.title,
                    requestor: message.user!,
                });
                await flushMovieQueue();
                await say({
                    text: "...added it to the queue!",
                    thread_ts: message.ts,
                });
            } else {
                await say({
                    text: `Try as I might, I couldn't find a movie called '${query}.' Are you sure you spelled it right? If that is the name of the movie, say "force add" to force add the query text instead.`,
                    thread_ts: message.ts,
                });
            }
        }
    } else if (
        (matches = /(?:remove) (?:(?:\"(.*)\"|_(.*)_)|(.*))/i.exec(text))
    ) {
        /* Remove movies */
        const query = matches![3].replace(/\?/g, "").toLowerCase();
        const indexToRemove = movieQueue.findIndex((movie) => {
            movie.title.toLowerCase().includes(query);
        });
        if (indexToRemove == -1) {
            await say({
                text: `There isn't a movie called '${query}' in the queue. Did you spell it right?`,
                thread_ts: message.ts,
            });
        } else {
            const movieName = movieQueue[indexToRemove].title;
            movieQueue.splice(indexToRemove, 1);
            flushMovieQueue();
            await say({
                text: `I really wish you all would take the time to see it, but I removed _${movieName}_ from the movie queue.`,
                thread_ts: message.ts,
            });
        }
    }
});

(async () => {
    const port = process.env.PORT ?? 3000;
    await app.start(port);
    console.log(`Started Bolt app on port ${port}`);
})();
