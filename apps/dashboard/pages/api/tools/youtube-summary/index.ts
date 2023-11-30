import { ConstructionOutlined } from '@mui/icons-material';
import cuid from 'cuid';
import { NextApiResponse } from 'next';
import { z, ZodSchema } from 'zod';

import ChatModel from '@chaindesk/lib/chat-model';
import { ModelConfig } from '@chaindesk/lib/config';
import countTokens from '@chaindesk/lib/count-tokens';
import {
  createLazyAuthHandler,
  respond,
} from '@chaindesk/lib/createa-api-handler';
import cors from '@chaindesk/lib/middlewares/cors';
import pipe from '@chaindesk/lib/middlewares/pipe';
import rateLimit from '@chaindesk/lib/middlewares/rate-limit';
import ytTool, { Schema } from '@chaindesk/lib/openai-tools/youtube-summary';
import runMiddleware from '@chaindesk/lib/run-middleware';
import splitTextByToken from '@chaindesk/lib/split-text-by-token';
import generateSummary from '@chaindesk/lib/summarize';
import { AppNextApiRequest } from '@chaindesk/lib/types';
import { YoutubeSummarySchema } from '@chaindesk/lib/types/dtos';
import validate from '@chaindesk/lib/validate';
import YoutubeApi from '@chaindesk/lib/youtube-api';
import zodParseJSON from '@chaindesk/lib/zod-parse-json';
import { AgentModelName, LLMTaskOutputType, Prisma } from '@chaindesk/prisma';
import { prisma } from '@chaindesk/prisma/client';

const handler = createLazyAuthHandler();

export const getLatestVideos = async (
  req: AppNextApiRequest,
  res: NextApiResponse
) => {
  const outputs = await prisma.lLMTaskOutput.findMany({
    where: {
      type: LLMTaskOutputType.youtube_summary,
    },
    take: 3,
    orderBy: {
      createdAt: 'desc',
    },
  });

  return outputs;
};

handler.get(respond(getLatestVideos));

export const createYoutubeSummary = async (
  req: AppNextApiRequest,
  res: NextApiResponse
) => {
  const { url } = YoutubeSummarySchema.parse(req.body);

  const Youtube = new YoutubeApi();
  const videoId = YoutubeApi.extractVideoId(url);
  //TODO: get video name,  description date published
  const videoSnippet = await Youtube.getVideoSnippetById(videoId!);
  const refresh =
    req.query.refresh === 'true' &&
    req?.session?.roles?.includes?.('SUPERADMIN');

  if (!videoId) {
    throw new Error('The url is not a valid youtube video.');
  }

  const found = await prisma.lLMTaskOutput.findUnique({
    where: {
      unique_external_id: {
        type: LLMTaskOutputType.youtube_summary,
        externalId: videoId,
      },
    },
  });

  if (found && !refresh) {
    return found;
  } else {
    const transcripts = await YoutubeApi.transcribeVideo(url);

    const groupBySentences = (t: typeof transcripts) => {
      const groupedTranscripts: (typeof transcripts)[] = [];
      let currentGroup = [] as any;

      t.forEach((transcript) => {
        if (transcript.text.trim().startsWith('-')) {
          if (currentGroup.length > 0) {
            groupedTranscripts.push(currentGroup);
            currentGroup = [];
          }
        }
        currentGroup.push(transcript);
      });

      // Add the last group if it's not empty
      if (currentGroup.length > 0) {
        groupedTranscripts.push(currentGroup);
      }

      return groupedTranscripts.map((each) => {
        return each.reduce((acc, item, index) => {
          if (index === 0) {
            return {
              ...item,
            };
          }
          return {
            ...acc,
            text: `${acc.text} ${item.text}`,
          };
        }, {} as (typeof transcripts)[0]);
      });
    };

    // const text = transcripts.reduce(
    //   (acc, { text, offset }) =>
    //     acc + `""" ${Math.ceil(offset / 1000)}s """ ${text} `,
    //   ''
    // );

    const text = groupBySentences(transcripts)
      .map((each) => ({
        text: each.text?.replace(/^- /, ''),
        offset: `${Math.ceil(each.offset / 1000)}s`,
      }))
      .map((each) => `[${each.offset}] ${each.text}`)
      .join('\n');

    const modelName = AgentModelName.gpt_4_turbo;
    const [chunkedText] = await splitTextByToken({
      text,
      chunkSize: ModelConfig[modelName].maxTokens * 0.7,
    });

    await rateLimit({
      duration: 60,
      limit: 2,
    })(req, res);

    const model = new ChatModel();

    const result = await model.call({
      model: ModelConfig[modelName].name,
      tools: [ytTool],
      tool_choice: {
        type: 'function',
        function: {
          name: 'youtube_summary',
        },
      },
      messages: [
        {
          role: 'system',
          content: `Your task is generate a very detailed summary of a youtube video transcript.
          Make sure your summary has useful and true information about the main points of the topic.
          Begin with a short introduction explaining the topic. If you can, use bullet points to list important details,
          and finish your summary with a concluding sentence.
          Also make sure you identify all chapters of the video in chronological order from the beginning to the end.
          Answer in English using rich markdown format.`,
        },
        {
          role: 'user',
          content: `Youtube video transcript: ${chunkedText}`,
        },
      ],
    });

    const data = zodParseJSON(Schema)(
      result?.completion?.choices?.[0]?.message?.tool_calls?.[0]?.function
        ?.arguments as string
    );

    const id = found?.id || cuid();

    const payload = {
      id,
      externalId: videoId,
      type: 'youtube_summary',
      output: {
        metadata: {
          ...videoSnippet,
        },
        en: {
          ...data,
        },
      },
      usage: result?.usage as any,
    } as Prisma.LLMTaskOutputCreateArgs['data'];

    const output = await prisma.lLMTaskOutput.upsert({
      where: {
        id,
      },
      create: payload,
      update: payload,
    });

    return output;
  }
};

handler.post(
  pipe(
    validate({
      handler: respond(createYoutubeSummary),
      body: YoutubeSummarySchema,
    })
  )
);

export default pipe(cors({ methods: ['GET', 'POST', 'HEAD'] }), handler);
