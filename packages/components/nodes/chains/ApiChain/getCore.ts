/**
 * GET variant of the locally-implemented APIChain.
 *
 * Mirrors `postCore.ts`, which exists because LangChain's `APIChain` performs its own unguarded
 * fetch. `GETApiChain` still imported the upstream class, so the GET half of GHSA-6r77-hqx7-7vw8
 * remained open after the POST half was closed — the guard existed in the sibling file and simply
 * was not used here.
 */
import { CallbackManagerForChainRun } from '@langchain/core/callbacks/manager'
import { BaseLanguageModel } from '@langchain/core/language_models/base'
import { BasePromptTemplate, PromptTemplate } from '@langchain/core/prompts'
import { ChainValues } from '@langchain/core/utils/types'
import { BaseChain, ChainInputs, LLMChain, SerializedAPIChain } from '@langchain/classic/chains'
import { secureFetch } from '../../../src'

export const API_URL_RAW_PROMPT_TEMPLATE = `You are given the below API Documentation:
{api_docs}
Using this documentation, generate the full API url to call for answering the user question.
You should build the API url in order to get a response that is as short as possible, while still getting the necessary information to answer the question.
You should build the json string in order to get a response that is as short as possible, while still getting the necessary information to answer the question. Pay attention to deliberately exclude any unnecessary pieces of data in the API call.

Question:{question}
json string:`

export const API_RESPONSE_RAW_PROMPT_TEMPLATE = `${API_URL_RAW_PROMPT_TEMPLATE} {api_url}

Here is the response from the API:

{api_response}

Summarize this response to answer the original question.

Summary:`

const defaultApiUrlPrompt = new PromptTemplate({
    inputVariables: ['api_docs', 'question'],
    template: API_URL_RAW_PROMPT_TEMPLATE
})

const defaultApiResponsePrompt = new PromptTemplate({
    inputVariables: ['api_docs', 'question', 'api_url', 'api_response'],
    template: API_RESPONSE_RAW_PROMPT_TEMPLATE
})

export interface APIChainInput extends Omit<ChainInputs, 'memory'> {
    apiAnswerChain: LLMChain
    apiRequestChain: LLMChain
    apiDocs: string
    inputKey?: string
    headers?: Record<string, string>
    /** Key to use for output, defaults to `output` */
    outputKey?: string
}

export type APIChainOptions = {
    headers?: Record<string, string>
    apiUrlPrompt?: BasePromptTemplate
    apiResponsePrompt?: BasePromptTemplate
}

export class APIChain extends BaseChain implements APIChainInput {
    apiAnswerChain: LLMChain

    apiRequestChain: LLMChain

    apiDocs: string

    headers = {}

    inputKey = 'question'

    outputKey = 'output'

    get inputKeys() {
        return [this.inputKey]
    }

    get outputKeys() {
        return [this.outputKey]
    }

    constructor(fields: APIChainInput) {
        super(fields)
        this.apiRequestChain = fields.apiRequestChain
        this.apiAnswerChain = fields.apiAnswerChain
        this.apiDocs = fields.apiDocs
        this.inputKey = fields.inputKey ?? this.inputKey
        this.outputKey = fields.outputKey ?? this.outputKey
        this.headers = fields.headers ?? this.headers
    }

    /** @ignore */
    async _call(values: ChainValues, runManager?: CallbackManagerForChainRun): Promise<ChainValues> {
        try {
            const question: string = values[this.inputKey]

            const api_url = await this.apiRequestChain.predict({ question, api_docs: this.apiDocs }, runManager?.getChild())

            const url = (api_url ?? '').trim()

            // The whole reason this file exists. LangChain's own APIChain fetches the
            // LLM-generated URL with an unguarded client: no deny list, no redirect
            // revalidation, no DNS-rebind protection. `secureFetch` resolves the host, checks it
            // against the deny list (cloud metadata, RFC1918, loopback, ::, CGNAT), walks
            // redirects revalidating every hop, and pins the validated IP into the connection.
            //
            // It matters more here than almost anywhere else: the URL is written by a language
            // model from user-supplied text, so prompt injection steers it — and the response is
            // fed back into the answer prompt, which makes the SSRF non-blind. The POST chain was
            // reimplemented for exactly this reason (GHSA-6r77-hqx7-7vw8 named both); the GET half
            // was left on the upstream class.
            const res = await secureFetch(url, {
                method: 'GET',
                headers: this.headers
            })

            const api_response = await res.text()

            const answer = await this.apiAnswerChain.predict(
                { question, api_docs: this.apiDocs, api_url, api_response },
                runManager?.getChild()
            )

            return { [this.outputKey]: answer }
        } catch (error) {
            return { [this.outputKey]: error }
        }
    }

    _chainType() {
        return 'api_chain' as const
    }

    static async deserialize(data: SerializedAPIChain) {
        const { api_request_chain, api_answer_chain, api_docs } = data

        if (!api_request_chain) {
            throw new Error('LLMChain must have api_request_chain')
        }
        if (!api_answer_chain) {
            throw new Error('LLMChain must have api_answer_chain')
        }
        if (!api_docs) {
            throw new Error('LLMChain must have api_docs')
        }

        return new APIChain({
            apiAnswerChain: await LLMChain.deserialize(api_answer_chain),
            apiRequestChain: await LLMChain.deserialize(api_request_chain),
            apiDocs: api_docs
        })
    }

    serialize(): SerializedAPIChain {
        return {
            _type: this._chainType(),
            api_answer_chain: this.apiAnswerChain.serialize(),
            api_request_chain: this.apiRequestChain.serialize(),
            api_docs: this.apiDocs
        }
    }

    static fromLLMAndAPIDocs(
        llm: BaseLanguageModel,
        apiDocs: string,
        options: APIChainOptions & Omit<APIChainInput, 'apiAnswerChain' | 'apiRequestChain' | 'apiDocs'> = {}
    ): APIChain {
        const { apiUrlPrompt = defaultApiUrlPrompt, apiResponsePrompt = defaultApiResponsePrompt } = options
        const apiRequestChain = new LLMChain({ prompt: apiUrlPrompt, llm })
        const apiAnswerChain = new LLMChain({ prompt: apiResponsePrompt, llm })
        return new this({
            apiAnswerChain,
            apiRequestChain,
            apiDocs,
            ...options
        })
    }
}
